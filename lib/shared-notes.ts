import { and, eq, sql } from "drizzle-orm";
import { interactions, participants, sharedNotes } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { SharedNotesConfig } from "@/lib/interaction-config";
import { isProfane } from "@/lib/profanity";

export const NOTE_TEXT_MAX = 500;

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

export type NoteResult =
  | { ok: true; note: NoteView }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

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

function validateText(raw: unknown): { ok: true; text: string } | { ok: false; status: 400; error: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, status: 400, error: "Write something first" };
  if (text.length > NOTE_TEXT_MAX) {
    return { ok: false, status: 400, error: `Notes must be at most ${NOTE_TEXT_MAX} characters` };
  }
  if (isProfane(text)) return { ok: false, status: 400, error: "That note contains language we can't accept" };
  return { ok: true, text };
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

const NOT_FOUND = { ok: false, status: 404, error: "Interaction not found" } as const;
const NOT_OPEN = { ok: false, status: 409, error: "Notes are not open" } as const;

export async function submitNote(
  interactionId: string,
  participantId: string,
  rawText: unknown,
): Promise<NoteResult> {
  return getDb().transaction(async (tx): Promise<NoteResult> => {
    const ctx = await lockContext(tx, interactionId, participantId);
    if (!ctx) return NOT_FOUND;
    if (ctx.interaction.state !== "live") return NOT_OPEN;

    const checked = validateText(rawText);
    if (!checked.ok) return checked;

    const config = settings(ctx.interaction.config);
    const [{ used }] = await tx
      .select({ used: sql<number>`count(*)::int` })
      .from(sharedNotes)
      .where(and(eq(sharedNotes.interactionId, interactionId), eq(sharedNotes.participantId, participantId)));
    if (used >= config.maxNotesPerParticipant) {
      return { ok: false, status: 409, error: "You have used all your notes" };
    }

    const nickname = ctx.nickname?.trim() || null;
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
  });
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
      return { ok: false, status: 404, error: "Note not found" };
    }
    const ctx = await lockContext(tx, found.interactionId, participantId);
    if (!ctx) return { ok: false, status: 404, error: "Note not found" };
    if (ctx.interaction.state !== "live") return NOT_OPEN;
    // Re-read under the lock: the note may have been deleted meanwhile.
    const [note] = await tx.select().from(sharedNotes).where(eq(sharedNotes.id, noteId));
    if (!note) return { ok: false, status: 404, error: "Note not found" };
    return run(tx, note, settings(ctx.interaction.config));
  });
}

export function editNote(noteId: string, participantId: string, rawText: unknown): Promise<NoteResult> {
  return withOwnNote(noteId, participantId, async (tx, note, config) => {
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
}

export function deleteNote(noteId: string, participantId: string): Promise<NoteResult> {
  return withOwnNote(noteId, participantId, async (tx, note) => {
    await tx.delete(sharedNotes).where(eq(sharedNotes.id, noteId));
    return { ok: true, note: toView(note) };
  });
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
