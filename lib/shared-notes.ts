import type { MessageKey, TParams } from "@/lib/i18n";
import { and, eq, sql } from "drizzle-orm";
import { interactions, participants, sharedNoteVotes, sharedNotes } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { SharedNotesConfig } from "@/lib/interaction-config";
import { isProfane } from "@/lib/profanity";
import { NOTE_TEXT_MAX } from "@/lib/note-limits";
import { AUTHOR_NAME_MAX_LENGTH } from "@/lib/question-types";
import { publish } from "@/lib/realtime/publisher";

export { NOTE_TEXT_MAX };

export type NoteView = {
  id: string;
  interactionId: string;
  text: string;
  authorName: string | null;
  status: "pending" | "approved" | "rejected";
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** What participants and the presenter may see of an approved note; never the participant id. */
export type PublicNote = {
  id: string;
  interactionId: string;
  text: string;
  authorName: string | null;
  pinned: boolean;
  createdAt: string;
  upvotes: number;
};

export type ParticipantNote = PublicNote & { mine: boolean; iUpvoted: boolean };

export type NoteResult =
  | { ok: true; note: NoteView }
  | { ok: false; status: 400 | 403 | 404 | 409; error: MessageKey; params?: TParams };

const toView = (row: typeof sharedNotes.$inferSelect): NoteView => ({
  id: row.id,
  interactionId: row.interactionId,
  text: row.text,
  authorName: row.authorName,
  status: row.status,
  pinned: row.pinned,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function validateText(raw: unknown): { ok: true; text: string } | { ok: false; status: 400; error: MessageKey; params?: TParams } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, status: 400, error: "api.writeFirst" };
  if (text.length > NOTE_TEXT_MAX) {
    return { ok: false, status: 400, error: "api.notesMax", params: { max: NOTE_TEXT_MAX } };
  }
  if (isProfane(text)) return { ok: false, status: 400, error: "api.profaneNote" };
  return { ok: true, text };
}

/** The optional display name sent with a note; empty means "use the participant's nickname, if any". */
function validateAuthorName(raw: unknown): { ok: true; name: string | null } | { ok: false; status: 400; error: MessageKey; params?: TParams } {
  if (raw === undefined || raw === null) return { ok: true, name: null };
  if (typeof raw !== "string") return { ok: false, status: 400, error: "api.invalidName" };
  const name = raw.trim();
  if (name.length > AUTHOR_NAME_MAX_LENGTH) {
    return { ok: false, status: 400, error: "api.namesMax", params: { max: AUTHOR_NAME_MAX_LENGTH } };
  }
  if (name && isProfane(name)) return { ok: false, status: 400, error: "api.profaneName" };
  return { ok: true, name: name || null };
}

const settings = (config: unknown): SharedNotesConfig => {
  const c = (config ?? {}) as Partial<SharedNotesConfig>;
  return {
    prompt: c.prompt ?? "",
    maxNotesPerParticipant: c.maxNotesPerParticipant ?? 3,
    moderation: c.moderation ?? "open",
    showAuthorNames: c.showAuthorNames ?? false,
  };
};

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Locks the interaction (share) and the participant (update); null unless both belong to one event. */
async function lockContext(tx: Tx, interactionId: string, participantId: string) {
  // Share lock: closing (an UPDATE) waits for in-flight writes.
  const [interaction] = await tx.select().from(interactions).where(eq(interactions.id, interactionId)).for("share");
  if (!interaction || interaction.type !== "sharedNotes") return null;
  // Row lock serialises one participant's writes so the limit can't be raced.
  const [participant] = await tx
    .select({ eventId: participants.eventId, nickname: participants.nickname })
    .from(participants)
    .where(eq(participants.id, participantId))
    .for("update");
  if (!participant || participant.eventId !== interaction.eventId) return null;
  return { interaction, nickname: participant.nickname };
}

const NOT_FOUND = { ok: false, status: 404, error: "api.interactionNotFound" } as const;
const NOT_OPEN = { ok: false, status: 409, error: "api.notesNotOpen" } as const;

export async function submitNote(
  interactionId: string,
  participantId: string,
  rawText: unknown,
  rawAuthorName?: unknown,
): Promise<NoteResult> {
  return getDb().transaction(async (tx): Promise<NoteResult> => {
    const ctx = await lockContext(tx, interactionId, participantId);
    if (!ctx) return NOT_FOUND;
    if (ctx.interaction.state !== "live") return NOT_OPEN;

    const checked = validateText(rawText);
    if (!checked.ok) return checked;
    const name = validateAuthorName(rawAuthorName);
    if (!name.ok) return name;

    const config = settings(ctx.interaction.config);
    const [{ used }] = await tx
      .select({ used: sql<number>`count(*)::int` })
      .from(sharedNotes)
      .where(and(eq(sharedNotes.interactionId, interactionId), eq(sharedNotes.participantId, participantId)));
    if (used >= config.maxNotesPerParticipant) {
      return { ok: false, status: 409, error: "api.notesUsed" };
    }

    const nickname = name.name ?? (ctx.nickname?.trim() || null);
    const [row] = await tx
      .insert(sharedNotes)
      .values({
        interactionId,
        participantId,
        text: checked.text,
        authorName: config.showAuthorNames ? nickname : null,
        status: config.moderation === "moderated" ? "pending" : "approved",
      })
      .returning();
    await tx
      .update(participants)
      .set({ firstResponseAt: sql`coalesce(${participants.firstResponseAt}, now())` })
      .where(eq(participants.id, participantId));
    return { ok: true, note: toView(row) };
  }).then((result) => announce(result, "added"));
}

/** Loads the note, then locks as in submitNote; only the author may proceed, and only while live. */
async function withOwnNote(
  noteId: string,
  participantId: string,
  run: (tx: Tx, note: typeof sharedNotes.$inferSelect, config: SharedNotesConfig) => Promise<NoteResult>,
): Promise<NoteResult> {
  return getDb().transaction(async (tx): Promise<NoteResult> => {
    const [found] = await tx.select().from(sharedNotes).where(eq(sharedNotes.id, noteId));
    if (!found || found.participantId !== participantId) {
      return { ok: false, status: 404, error: "api.noteNotFound" };
    }
    const ctx = await lockContext(tx, found.interactionId, participantId);
    if (!ctx) return { ok: false, status: 404, error: "api.noteNotFound" };
    if (ctx.interaction.state !== "live") return NOT_OPEN;
    // Re-read under the lock: the note may have been deleted meanwhile.
    const [note] = await tx.select().from(sharedNotes).where(eq(sharedNotes.id, noteId));
    if (!note) return { ok: false, status: 404, error: "api.noteNotFound" };
    return run(tx, note, settings(ctx.interaction.config));
  });
}

export async function editNote(noteId: string, participantId: string, rawText: unknown): Promise<NoteResult> {
  const result = await withOwnNote(noteId, participantId, async (tx, note, config) => {
    const checked = validateText(rawText);
    if (!checked.ok) return checked;
    const [row] = await tx
      .update(sharedNotes)
      .set({
        text: checked.text,
        status: config.moderation === "moderated" ? "pending" : note.status,
        updatedAt: sql`now()`,
      })
      .where(eq(sharedNotes.id, noteId))
      .returning();
    return { ok: true, note: toView(row) };
  });
  return announce(result, "updated");
}

export async function deleteNote(noteId: string, participantId: string): Promise<NoteResult> {
  const result = await withOwnNote(noteId, participantId, async (tx, note) => {
    await tx.delete(sharedNotes).where(eq(sharedNotes.id, noteId));
    return { ok: true, note: toView(note) };
  });
  return announce(result, "removed");
}

/**
 * Tells the event room about a note change. Approved notes go to everyone; a note that is (or went back to)
 * pending reaches only the host, and audiences are told to drop it.
 */
async function announce(result: NoteResult, kind: "added" | "updated" | "removed"): Promise<NoteResult> {
  if (!result.ok) return result;
  const note = result.note;
  const [row] = await getDb()
    .select({ eventId: interactions.eventId })
    .from(interactions)
    .where(eq(interactions.id, note.interactionId));
  if (!row) return result;
  const visible = kind !== "removed" && note.status === "approved";
  if (visible) {
    publish(row.eventId, `note:${kind}`, { note: await publicNote(note.id) });
  } else {
    publish(row.eventId, "note:removed", { interactionId: note.interactionId, noteId: note.id });
    if (kind !== "removed" && note.status === "pending") {
      publish(row.eventId, "note:pending", { interactionId: note.interactionId, noteId: note.id }, { hostOnly: true });
    }
  }
  return result;
}

async function publicNote(noteId: string): Promise<PublicNote | null> {
  const [row] = await getDb().select().from(sharedNotes).where(eq(sharedNotes.id, noteId));
  if (!row) return null;
  const [{ n }] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(sharedNoteVotes)
    .where(eq(sharedNoteVotes.noteId, noteId));
  return {
    id: row.id,
    interactionId: row.interactionId,
    text: row.text,
    authorName: row.authorName,
    pinned: row.pinned,
    createdAt: row.createdAt.toISOString(),
    upvotes: n,
  };
}

export type NoteSort = "popular" | "recent";

export type ListResult =
  | { ok: true; notes: ParticipantNote[] }
  | { ok: false; status: 404; error: MessageKey; params?: TParams };

/** Approved notes only, pinned first. Draft interactions look like they don't exist. */
export async function listNotes(
  interactionId: string,
  participantId: string,
  sort: NoteSort,
): Promise<ListResult> {
  const db = getDb();
  const [interaction] = await db
    .select({ type: interactions.type, state: interactions.state, eventId: interactions.eventId })
    .from(interactions)
    .where(eq(interactions.id, interactionId));
  if (!interaction || interaction.type !== "sharedNotes" || interaction.state === "draft") {
    return { ok: false, status: 404, error: "api.interactionNotFound" };
  }
  const [participant] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.eventId, interaction.eventId)));
  if (!participant) return { ok: false, status: 404, error: "api.interactionNotFound" };

  const rows = await db
    .select()
    .from(sharedNotes)
    .where(and(eq(sharedNotes.interactionId, interactionId), eq(sharedNotes.status, "approved")));
  const counts = await db
    .select({ noteId: sharedNoteVotes.noteId, n: sql<number>`count(*)::int` })
    .from(sharedNoteVotes)
    .innerJoin(sharedNotes, eq(sharedNotes.id, sharedNoteVotes.noteId))
    .where(and(eq(sharedNotes.interactionId, interactionId), eq(sharedNotes.status, "approved")))
    .groupBy(sharedNoteVotes.noteId);
  const countById = new Map(counts.map((c) => [c.noteId, c.n]));
  const mine = new Set(
    (
      await db
        .select({ noteId: sharedNoteVotes.noteId })
        .from(sharedNoteVotes)
        .innerJoin(sharedNotes, eq(sharedNotes.id, sharedNoteVotes.noteId))
        .where(and(eq(sharedNotes.interactionId, interactionId), eq(sharedNoteVotes.participantId, participantId)))
    ).map((v) => v.noteId),
  );

  const notes = rows
    .map((r): ParticipantNote => ({
      id: r.id,
      interactionId: r.interactionId,
      text: r.text,
      authorName: r.authorName,
      pinned: r.pinned,
      createdAt: r.createdAt.toISOString(),
      upvotes: countById.get(r.id) ?? 0,
      mine: r.participantId === participantId,
      iUpvoted: mine.has(r.id),
    }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const recent = b.createdAt.localeCompare(a.createdAt);
      if (sort === "recent") return recent;
      return b.upvotes - a.upvotes || recent;
    });
  return { ok: true, notes };
}

/** Approved notes for the presenter screen, with vote counts and no participant ids. */
export async function listPresenterNotes(interactionId: string): Promise<PublicNote[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(sharedNotes)
    .where(and(eq(sharedNotes.interactionId, interactionId), eq(sharedNotes.status, "approved")));
  const counts = await db
    .select({ noteId: sharedNoteVotes.noteId, n: sql<number>`count(*)::int` })
    .from(sharedNoteVotes)
    .innerJoin(sharedNotes, eq(sharedNotes.id, sharedNoteVotes.noteId))
    .where(and(eq(sharedNotes.interactionId, interactionId), eq(sharedNotes.status, "approved")))
    .groupBy(sharedNoteVotes.noteId);
  const countById = new Map(counts.map((c) => [c.noteId, c.n]));
  return rows.map((r) => ({
    id: r.id,
    interactionId: r.interactionId,
    text: r.text,
    authorName: r.authorName,
    pinned: r.pinned,
    createdAt: r.createdAt.toISOString(),
    upvotes: countById.get(r.id) ?? 0,
  }));
}

export type UpvoteResult =
  | { ok: true; upvoted: boolean; upvotes: number }
  | { ok: false; status: 403 | 404 | 409; error: MessageKey; params?: TParams };

/** Toggles the participant's upvote. Hidden (pending/rejected) notes look like they don't exist. */
export async function toggleNoteUpvote(noteId: string, participantId: string): Promise<UpvoteResult> {
  const db = getDb();
  const outcome = await db.transaction(async (tx): Promise<UpvoteResult & { eventId?: string; interactionId?: string }> => {
    const [found] = await tx.select({ interactionId: sharedNotes.interactionId }).from(sharedNotes).where(eq(sharedNotes.id, noteId));
    if (!found) return { ok: false, status: 404, error: "api.noteNotFound" };
    // Share-lock the interaction like the write paths, so closing waits for in-flight votes.
    const [interaction] = await tx.select().from(interactions).where(eq(interactions.id, found.interactionId)).for("share");
    // FOR SHARE keeps a concurrent moderation change from slipping between the status check and the write.
    const [note] = await tx.select().from(sharedNotes).where(eq(sharedNotes.id, noteId)).for("share");
    if (!interaction || !note || note.status !== "approved") return { ok: false, status: 404, error: "api.noteNotFound" };
    const [participant] = await tx
      .select({ id: participants.id })
      .from(participants)
      .where(and(eq(participants.id, participantId), eq(participants.eventId, interaction.eventId)));
    if (!participant) return { ok: false, status: 404, error: "api.noteNotFound" };
    if (interaction.state === "draft") return { ok: false, status: 409, error: "api.notesNotOpen" };
    if (note.participantId === participantId) {
      return { ok: false, status: 403, error: "api.ownNoteUpvote" };
    }

    const removed = await tx
      .delete(sharedNoteVotes)
      .where(and(eq(sharedNoteVotes.noteId, noteId), eq(sharedNoteVotes.participantId, participantId)))
      .returning({ id: sharedNoteVotes.id });
    if (removed.length === 0) {
      await tx.insert(sharedNoteVotes).values({ noteId, participantId }).onConflictDoNothing();
    }
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sharedNoteVotes)
      .where(eq(sharedNoteVotes.noteId, noteId));
    return { ok: true, upvoted: removed.length === 0, upvotes: n, eventId: interaction.eventId, interactionId: interaction.id };
  });
  if (!outcome.ok) return outcome;
  publish(outcome.eventId!, "note:votes", { interactionId: outcome.interactionId, noteId, upvotes: outcome.upvotes });
  return { ok: true, upvoted: outcome.upvoted, upvotes: outcome.upvotes };
}

/** The event a note belongs to, for resolving the participant cookie. */
export async function findNoteEventId(noteId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ eventId: interactions.eventId })
    .from(sharedNotes)
    .innerJoin(interactions, eq(interactions.id, sharedNotes.interactionId))
    .where(eq(sharedNotes.id, noteId));
  return row?.eventId ?? null;
}
