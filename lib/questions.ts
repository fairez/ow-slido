import type { MessageKey, TParams } from "@/lib/i18n";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { events, interactions, participants, questionVotes, questions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { newInteractionConfig, QA_DEFAULT_PROMPT, QA_DEFAULT_TITLE, type QaConfig } from "@/lib/interaction-config";
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

type Conn = Pick<ReturnType<typeof getDb>, "select">;

/** Config as stored, with defaults for fields older rows lack (the profanity filter is on unless switched off). */
export const readQaConfig = (raw: unknown): QaConfig =>
  newInteractionConfig("qa", raw && typeof raw === "object" ? (raw as Partial<QaConfig>) : {});

/** A Q&A interaction by id with its event; null for any other type or an unknown id. */
export async function findQaInteraction(
  interactionId: string,
): Promise<{ id: string; eventId: string; config: QaConfig } | null> {
  if (!isUuid(interactionId)) return null;
  const [row] = await getDb()
    .select({ id: interactions.id, eventId: interactions.eventId, type: interactions.type, config: interactions.config })
    .from(interactions)
    .where(eq(interactions.id, interactionId));
  return row && row.type === "qa" ? { id: row.id, eventId: row.eventId, config: readQaConfig(row.config) } : null;
}

/**
 * The Q&A that the event-level routes stand for: the live one, else the first by position. Null when the
 * event has none.
 */
export async function resolveEventQa(conn: Conn, eventId: string): Promise<string | null> {
  const [row] = await conn
    .select({ id: interactions.id })
    .from(interactions)
    .where(and(eq(interactions.eventId, eventId), eq(interactions.type, "qa")))
    .orderBy(sql`(${interactions.state} = 'live') desc`, asc(interactions.position), asc(interactions.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** `resolveEventQa`, creating a paused Q&A (moderation copied from the event) when the event has none. */
export async function ensureQaInteraction(db: ReturnType<typeof getDb>, eventId: string): Promise<string> {
  const existing = await resolveEventQa(db, eventId);
  if (existing) return existing;
  return db.transaction(async (tx) => {
    // Two first questions arriving together must not each create a Q&A.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"qa:" + eventId}))`);
    const again = await resolveEventQa(tx, eventId);
    if (again) return again;
    const [event] = await tx.select({ moderationMode: events.moderationMode }).from(events).where(eq(events.id, eventId));
    const [created] = await tx
      .insert(interactions)
      .values({
        eventId,
        type: "qa",
        title: QA_DEFAULT_TITLE,
        state: "paused",
        position: sql`(select coalesce(max(position) + 1, 0) from interactions where event_id = ${eventId})`,
        config: newInteractionConfig("qa", { prompt: QA_DEFAULT_PROMPT, moderation: event?.moderationMode ?? "open" }),
      })
      .returning({ id: interactions.id });
    return created.id;
  });
}

type SubmitResult =
  | { ok: true; status: "pending" | "approved"; question: PublicQuestion }
  | { ok: false; status: 400 | 404; error: MessageKey; params?: TParams };

/** Anonymous unless a non-empty name is given; pending when the Q&A is moderated, approved when it is open. */
export async function submitQuestion(
  interactionId: string,
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

  const qa = await findQaInteraction(interactionId);
  if (!qa) return { ok: false, status: 404, error: "api.interactionNotFound" };
  const { eventId, config } = qa;
  if (config.profanityFilter && (isProfane(text) || (authorName && isProfane(authorName)))) {
    return { ok: false, status: 400, error: "api.profaneQuestion" };
  }

  const db = getDb();
  const [participant] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.eventId, eventId)));
  if (!participant) return { ok: false, status: 404, error: "api.eventNotFound" };

  const status = config.moderation === "moderated" ? "pending" : "approved";
  const [row] = await db
    .insert(questions)
    .values({ eventId, interactionId, participantId, text, authorName, status })
    .returning();
  const question = toPublicQuestion(row);

  if (status === "approved") publish(eventId, "question:added", { interactionId, question });
  else publish(eventId, "question:pending", { interactionId, question }, { hostOnly: true });

  return { ok: true, status, question };
}

/** Approved questions of one Q&A only: pinned first, then newest first. `upvoted` reflects `participantId`, if given. */
export async function listApprovedQuestions(interactionId: string, participantId?: string): Promise<PublicQuestion[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(questions)
    .where(and(eq(questions.interactionId, interactionId), eq(questions.status, "approved")))
    .orderBy(desc(questions.pinned), desc(questions.createdAt));
  if (rows.length === 0) return [];
  const counts = await db
    .select({ questionId: questionVotes.questionId, n: sql<number>`count(*)::int` })
    .from(questionVotes)
    .innerJoin(questions, eq(questions.id, questionVotes.questionId))
    .where(and(eq(questions.interactionId, interactionId), eq(questions.status, "approved")))
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

/** Approved questions of the event's live (else first) Q&A; empty when it has none. */
export async function listEventQuestions(eventId: string, participantId?: string): Promise<PublicQuestion[]> {
  const interactionId = await resolveEventQa(getDb(), eventId);
  return interactionId ? listApprovedQuestions(interactionId, participantId) : [];
}

type UpvoteResult =
  | { ok: true; upvoted: boolean; upvotes: number }
  | { ok: false; status: 404; error: MessageKey; params?: TParams };

/**
 * Toggles the participant's upvote on an approved question; pending/rejected ones look like they don't exist.
 * With `interactionId`, a question of another Q&A looks missing too.
 */
export async function toggleUpvote(
  questionId: string,
  participantId: string,
  interactionId?: string,
): Promise<UpvoteResult> {
  const notFound = { ok: false, status: 404, error: "api.questionNotFound" } as const;
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // FOR SHARE keeps a concurrent moderation change from slipping between the status check and the write.
    const [question] = await tx
      .select({ eventId: questions.eventId, interactionId: questions.interactionId, status: questions.status })
      .from(questions)
      .where(eq(questions.id, questionId))
      .for("share");
    if (!question || question.status !== "approved") return null;
    if (interactionId && question.interactionId !== interactionId) return null;
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
    return { eventId: question.eventId, interactionId: question.interactionId, upvoted: removed.length === 0, upvotes: n };
  });
  if (!result) return notFound;
  publish(result.eventId, "question:votes", { interactionId: result.interactionId, questionId, upvotes: result.upvotes });
  return { ok: true, upvoted: result.upvoted, upvotes: result.upvotes };
}
