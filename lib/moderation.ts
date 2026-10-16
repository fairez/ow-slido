import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { interactions, questionVotes, questions, sharedNoteVotes, sharedNotes } from "@/db/schema";
import { getDb } from "@/lib/db";
import { publish } from "@/lib/realtime/publisher";
import { toPublicQuestion } from "@/lib/questions";
import type { HostNote } from "@/lib/note-types";
import type { HostQuestion } from "@/lib/question-types";

type Row = typeof questions.$inferSelect;

const toHostQuestion = (row: Row, upvotes: number): HostQuestion => ({
  ...toPublicQuestion(row, upvotes),
  status: row.status === "pending" ? "pending" : "approved",
});

/** Pending and approved questions for the host (rejected ones are gone from the queue): pinned first, then newest. */
export async function listHostQuestions(eventId: string): Promise<HostQuestion[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(questions)
    .where(and(eq(questions.eventId, eventId), inArray(questions.status, ["pending", "approved"])))
    .orderBy(desc(questions.pinned), desc(questions.createdAt));
  if (rows.length === 0) return [];
  const counts = await db
    .select({ questionId: questionVotes.questionId, n: sql<number>`count(*)::int` })
    .from(questionVotes)
    .innerJoin(questions, eq(questions.id, questionVotes.questionId))
    .where(eq(questions.eventId, eventId))
    .groupBy(questionVotes.questionId);
  const countById = new Map(counts.map((c) => [c.questionId, c.n]));
  return rows.map((r) => toHostQuestion(r, countById.get(r.id) ?? 0));
}

export type ModerationChange = { status?: unknown; pinned?: unknown; answered?: unknown };

type ModerationResult =
  | { ok: true; question: HostQuestion | null }
  | { ok: false; status: 400 | 404 | 409; error: string };

const notFound = { ok: false, status: 404, error: "Question not found" } as const;

async function upvoteCount(questionId: string) {
  const [{ n }] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(questionVotes)
    .where(eq(questionVotes.questionId, questionId));
  return n;
}

/**
 * Applies a host change to a question of the event. `status` may move a pending question to
 * approved/rejected; `pinned` and `answered` only apply to approved questions.
 */
export async function moderateQuestion(
  eventId: string,
  questionId: string,
  change: ModerationChange,
): Promise<ModerationResult> {
  const { status, pinned, answered } = change;
  if (status !== undefined && status !== "approved" && status !== "rejected") {
    return { ok: false, status: 400, error: "Status must be 'approved' or 'rejected'" };
  }
  if ((pinned !== undefined && typeof pinned !== "boolean") || (answered !== undefined && typeof answered !== "boolean")) {
    return { ok: false, status: 400, error: "pinned and answered must be booleans" };
  }
  if (status === undefined && pinned === undefined && answered === undefined) {
    return { ok: false, status: 400, error: "Nothing to change" };
  }

  const db = getDb();
  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(questions)
      .where(and(eq(questions.id, questionId), eq(questions.eventId, eventId)))
      .for("update");
    if (!current || current.status === "rejected") return notFound;

    const set: Partial<Pick<Row, "status" | "pinned" | "answered">> = {};
    if (status !== undefined) {
      if (current.status !== "pending") {
        return { ok: false, status: 409, error: "Question was already moderated" } as const;
      }
      set.status = status;
    }
    const finalStatus = set.status ?? current.status;
    if (pinned !== undefined || answered !== undefined) {
      if (finalStatus !== "approved") {
        return { ok: false, status: 409, error: "Approve the question first" } as const;
      }
      if (pinned !== undefined) set.pinned = pinned;
      if (answered !== undefined) set.answered = answered;
    }
    const [row] = await tx.update(questions).set(set).where(eq(questions.id, questionId)).returning();
    return { ok: true, row, approvedNow: current.status === "pending" && set.status === "approved" } as const;
  });
  if (!outcome.ok) return outcome;

  const { row, approvedNow } = outcome;
  if (row.status === "rejected") return { ok: true, question: null };
  const question = toHostQuestion(row, await upvoteCount(row.id));
  if (approvedNow) {
    publish(eventId, "question:added", { question: toPublicQuestion(row, question.upvotes) });
  } else if (row.status === "approved") {
    publish(eventId, "question:updated", { questionId: row.id, pinned: row.pinned, answered: row.answered });
  }
  return { ok: true, question };
}

/** Deletes a question (any status). Participants are told only if it was visible to them. */
export async function deleteQuestion(eventId: string, questionId: string): Promise<boolean> {
  const [row] = await getDb()
    .delete(questions)
    .where(and(eq(questions.id, questionId), eq(questions.eventId, eventId)))
    .returning({ status: questions.status });
  if (!row) return false;
  if (row.status === "approved") publish(eventId, "question:removed", { questionId });
  return true;
}

type NoteRow = typeof sharedNotes.$inferSelect;

const toHostNote = (row: NoteRow, interactionTitle: string, upvotes: number): HostNote => ({
  id: row.id,
  interactionId: row.interactionId,
  interactionTitle,
  text: row.text,
  authorName: row.authorName,
  status: row.status === "pending" ? "pending" : "approved",
  pinned: row.pinned,
  createdAt: row.createdAt.toISOString(),
  upvotes,
});

/** Pending and approved notes of the event for the host or a moderator: pinned first, then newest. */
export async function listHostNotes(eventId: string): Promise<HostNote[]> {
  const db = getDb();
  const rows = await db
    .select({ note: sharedNotes, title: interactions.title })
    .from(sharedNotes)
    .innerJoin(interactions, eq(interactions.id, sharedNotes.interactionId))
    .where(and(eq(interactions.eventId, eventId), inArray(sharedNotes.status, ["pending", "approved"])))
    .orderBy(desc(sharedNotes.pinned), desc(sharedNotes.createdAt));
  if (rows.length === 0) return [];
  const counts = await db
    .select({ noteId: sharedNoteVotes.noteId, n: sql<number>`count(*)::int` })
    .from(sharedNoteVotes)
    .innerJoin(sharedNotes, eq(sharedNotes.id, sharedNoteVotes.noteId))
    .innerJoin(interactions, eq(interactions.id, sharedNotes.interactionId))
    .where(eq(interactions.eventId, eventId))
    .groupBy(sharedNoteVotes.noteId);
  const countById = new Map(counts.map((c) => [c.noteId, c.n]));
  return rows.map((r) => toHostNote(r.note, r.title, countById.get(r.note.id) ?? 0));
}

export type NoteModerationChange = { status?: unknown; pinned?: unknown };

type NoteModerationResult =
  | { ok: true; note: HostNote | null }
  | { ok: false; status: 400 | 404 | 409; error: string };

const noteNotFound = { ok: false, status: 404, error: "Note not found" } as const;

/**
 * Applies a host change to a note of the event. `status` moves a pending note to approved/rejected;
 * `pinned` only applies to approved notes. Participants are told only about what they may see.
 */
export async function moderateNote(
  eventId: string,
  noteId: string,
  change: NoteModerationChange,
): Promise<NoteModerationResult> {
  const { status, pinned } = change;
  if (status !== undefined && status !== "approved" && status !== "rejected") {
    return { ok: false, status: 400, error: "Status must be 'approved' or 'rejected'" };
  }
  if (pinned !== undefined && typeof pinned !== "boolean") {
    return { ok: false, status: 400, error: "pinned must be a boolean" };
  }
  if (status === undefined && pinned === undefined) {
    return { ok: false, status: 400, error: "Nothing to change" };
  }

  const outcome = await getDb().transaction(async (tx) => {
    const [found] = await tx
      .select({ id: sharedNotes.id })
      .from(sharedNotes)
      .innerJoin(interactions, eq(interactions.id, sharedNotes.interactionId))
      .where(and(eq(sharedNotes.id, noteId), eq(interactions.eventId, eventId)));
    if (!found) return noteNotFound;
    const [current] = await tx.select().from(sharedNotes).where(eq(sharedNotes.id, noteId)).for("update");
    if (!current || current.status === "rejected") return noteNotFound;

    const set: Partial<Pick<NoteRow, "status" | "pinned">> = {};
    if (status !== undefined) {
      if (current.status !== "pending") {
        return { ok: false, status: 409, error: "Note was already moderated" } as const;
      }
      set.status = status;
    }
    if (pinned !== undefined) {
      if ((set.status ?? current.status) !== "approved") {
        return { ok: false, status: 409, error: "Approve the note first" } as const;
      }
      set.pinned = pinned;
    }
    const [row] = await tx.update(sharedNotes).set(set).where(eq(sharedNotes.id, noteId)).returning();
    return { ok: true, row, approvedNow: current.status === "pending" && set.status === "approved" } as const;
  });
  if (!outcome.ok) return outcome;

  const { row, approvedNow } = outcome;
  if (row.status === "rejected") return { ok: true, note: null };
  const [{ title }] = await getDb()
    .select({ title: interactions.title })
    .from(interactions)
    .where(eq(interactions.id, row.interactionId));
  const [{ n }] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(sharedNoteVotes)
    .where(eq(sharedNoteVotes.noteId, row.id));
  const hostNote = toHostNote(row, title, n);
  publish(eventId, approvedNow ? "note:added" : "note:updated", {
    note: {
      id: row.id,
      interactionId: row.interactionId,
      text: row.text,
      authorName: row.authorName,
      pinned: row.pinned,
      createdAt: hostNote.createdAt,
      upvotes: n,
    },
  });
  return { ok: true, note: hostNote };
}

/** Deletes a note (any status). Participants are told only if it was visible to them. */
export async function deleteNoteAsHost(eventId: string, noteId: string): Promise<boolean> {
  const db = getDb();
  const [found] = await db
    .select({ id: sharedNotes.id })
    .from(sharedNotes)
    .innerJoin(interactions, eq(interactions.id, sharedNotes.interactionId))
    .where(and(eq(sharedNotes.id, noteId), eq(interactions.eventId, eventId)));
  if (!found) return false;
  const [row] = await db
    .delete(sharedNotes)
    .where(eq(sharedNotes.id, noteId))
    .returning({ status: sharedNotes.status, interactionId: sharedNotes.interactionId });
  if (!row) return false;
  if (row.status === "approved") publish(eventId, "note:removed", { interactionId: row.interactionId, noteId });
  return true;
}
