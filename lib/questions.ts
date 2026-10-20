import type { MessageKey, TParams } from "@/lib/i18n";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { events, interactions, participants, questionVotes, questions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { QA_DEFAULT_PROMPT, QA_DEFAULT_TITLE } from "@/lib/interaction-config";
import { isProfane } from "@/lib/profanity";
import { publish } from "@/lib/realtime/publisher";
import { AUTHOR_NAME_MAX_LENGTH, QUESTION_MAX_LENGTH, type PublicQuestion } from "@/lib/question-types";

export { AUTHOR_NAME_MAX_LENGTH, QUESTION_MAX_LENGTH, type PublicQuestion };

type Row = typeof questions.$inferSelect;
export const toPublicQuestion = (row: Row, upvotes = 0, upvoted = false): PublicQuestion => ({
  id: row.id,
  text: row.text,
  authorName: row.authorName,
  answered: row.answered,
  pinned: row.pinned,
  createdAt: row.createdAt.toISOString(),
  upvotes,
  upvoted,
});

/**
 * The event's Q&A interaction (the first by position), created paused when the event has none. The event-level
 * Q&A routes still address questions by event, so they file each question under this one until they take an
 * interaction id themselves.
 */
export async function ensureQaInteraction(db: ReturnType<typeof getDb>, eventId: string): Promise<string> {
  const find = (conn: Pick<typeof db, "select">) =>
    conn
      .select({ id: interactions.id })
      .from(interactions)
      .where(and(eq(interactions.eventId, eventId), eq(interactions.type, "qa")))
      .orderBy(asc(interactions.position), asc(interactions.createdAt))
      .limit(1);
  const [existing] = await find(db);
  if (existing) return existing.id;
  return db.transaction(async (tx) => {
    // Two first questions arriving together must not each create a Q&A.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"qa:" + eventId}))`);
    const [again] = await find(tx);
    if (again) return again.id;
    const [event] = await tx.select({ moderationMode: events.moderationMode }).from(events).where(eq(events.id, eventId));
    const [created] = await tx
      .insert(interactions)
      .values({
        eventId,
        type: "qa",
        title: QA_DEFAULT_TITLE,
        state: "paused",
        position: sql`(select coalesce(max(position) + 1, 0) from interactions where event_id = ${eventId})`,
        config: { prompt: QA_DEFAULT_PROMPT, moderation: event?.moderationMode ?? "open" },
      })
      .returning({ id: interactions.id });
    return created.id;
  });
}

type SubmitResult =
  | { ok: true; status: "pending" | "approved"; question: PublicQuestion }
  | { ok: false; status: 400 | 404; error: MessageKey; params?: TParams };

/** Anonymous unless a non-empty name is given; pending in moderated events, approved in open ones. */
export async function submitQuestion(
  eventId: string,
  participantId: string,
  input: { text?: unknown; authorName?: unknown },
): Promise<SubmitResult> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) return { ok: false, status: 400, error: "api.questionRequired" };
  if (text.length > QUESTION_MAX_LENGTH) {
    return { ok: false, status: 400, error: "api.questionMax", params: { max: QUESTION_MAX_LENGTH } };
  }
  let authorName: string | null = null;
  if (input.authorName !== undefined && input.authorName !== null) {
    if (typeof input.authorName !== "string") return { ok: false, status: 400, error: "api.invalidName" };
    const name = input.authorName.trim();
    if (name.length > AUTHOR_NAME_MAX_LENGTH) {
      return { ok: false, status: 400, error: "api.nameMax", params: { max: AUTHOR_NAME_MAX_LENGTH } };
    }
    authorName = name || null;
  }
  if (isProfane(text) || (authorName && isProfane(authorName))) {
    return { ok: false, status: 400, error: "api.profaneQuestion" };
  }

  const db = getDb();
  const [event] = await db
    .select({ moderationMode: events.moderationMode })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) return { ok: false, status: 404, error: "api.eventNotFound" };
  const [participant] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.eventId, eventId)));
  if (!participant) return { ok: false, status: 404, error: "api.eventNotFound" };

  const status = event.moderationMode === "moderated" ? "pending" : "approved";
  const interactionId = await ensureQaInteraction(db, eventId);
  const [row] = await db
    .insert(questions)
    .values({ eventId, interactionId, participantId, text, authorName, status })
    .returning();
  const question = toPublicQuestion(row);

  if (status === "approved") publish(eventId, "question:added", { question });
  else publish(eventId, "question:pending", { question }, { hostOnly: true });

  return { ok: true, status, question };
}

/** Approved questions only: pinned first, then newest first. `upvoted` reflects `participantId`, if given. */
export async function listApprovedQuestions(eventId: string, participantId?: string): Promise<PublicQuestion[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(questions)
    .where(and(eq(questions.eventId, eventId), eq(questions.status, "approved")))
    .orderBy(desc(questions.pinned), desc(questions.createdAt));
  if (rows.length === 0) return [];
  const counts = await db
    .select({ questionId: questionVotes.questionId, n: sql<number>`count(*)::int` })
    .from(questionVotes)
    .innerJoin(questions, eq(questions.id, questionVotes.questionId))
    .where(and(eq(questions.eventId, eventId), eq(questions.status, "approved")))
    .groupBy(questionVotes.questionId);
  const countById = new Map(counts.map((c) => [c.questionId, c.n]));
  const mine = new Set(
    participantId
      ? (
          await db
            .select({ questionId: questionVotes.questionId })
            .from(questionVotes)
            .where(eq(questionVotes.participantId, participantId))
        ).map((v) => v.questionId)
      : [],
  );
  return rows.map((r) => toPublicQuestion(r, countById.get(r.id) ?? 0, mine.has(r.id)));
}

type UpvoteResult =
  | { ok: true; upvoted: boolean; upvotes: number }
  | { ok: false; status: 404; error: MessageKey; params?: TParams };

/** Toggles the participant's upvote on an approved question; pending/rejected ones look like they don't exist. */
export async function toggleUpvote(questionId: string, participantId: string): Promise<UpvoteResult> {
  const notFound = { ok: false, status: 404, error: "api.questionNotFound" } as const;
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // FOR SHARE keeps a concurrent moderation change from slipping between the status check and the write.
    const [question] = await tx
      .select({ eventId: questions.eventId, status: questions.status })
      .from(questions)
      .where(eq(questions.id, questionId))
      .for("share");
    if (!question || question.status !== "approved") return null;
    const [participant] = await tx
      .select({ id: participants.id })
      .from(participants)
      .where(and(eq(participants.id, participantId), eq(participants.eventId, question.eventId)));
    if (!participant) return null;

    const removed = await tx
      .delete(questionVotes)
      .where(and(eq(questionVotes.questionId, questionId), eq(questionVotes.participantId, participantId)))
      .returning({ id: questionVotes.id });
    if (removed.length === 0) {
      await tx.insert(questionVotes).values({ questionId, participantId }).onConflictDoNothing();
    }
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(questionVotes)
      .where(eq(questionVotes.questionId, questionId));
    return { eventId: question.eventId, upvoted: removed.length === 0, upvotes: n };
  });
  if (!result) return notFound;
  publish(result.eventId, "question:votes", { questionId, upvotes: result.upvotes });
  return { ok: true, upvoted: result.upvoted, upvotes: result.upvotes };
}
