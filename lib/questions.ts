import { and, desc, eq } from "drizzle-orm";
import { events, participants, questions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isProfane } from "@/lib/profanity";
import { publish } from "@/lib/realtime/publisher";

export const QUESTION_MAX_LENGTH = 300;
export const AUTHOR_NAME_MAX_LENGTH = 40;

/** The shape participants may see; never includes participant ids or status. */
export type PublicQuestion = {
  id: string;
  text: string;
  authorName: string | null;
  answered: boolean;
  pinned: boolean;
  createdAt: string;
};

type Row = typeof questions.$inferSelect;
export const toPublicQuestion = (row: Row): PublicQuestion => ({
  id: row.id,
  text: row.text,
  authorName: row.authorName,
  answered: row.answered,
  pinned: row.pinned,
  createdAt: row.createdAt.toISOString(),
});

type SubmitResult =
  | { ok: true; status: "pending" | "approved"; question: PublicQuestion }
  | { ok: false; status: 400 | 404; error: string };

/** Anonymous unless a non-empty name is given; pending in moderated events, approved in open ones. */
export async function submitQuestion(
  eventId: string,
  participantId: string,
  input: { text?: unknown; authorName?: unknown },
): Promise<SubmitResult> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) return { ok: false, status: 400, error: "Question is required" };
  if (text.length > QUESTION_MAX_LENGTH) {
    return { ok: false, status: 400, error: `Question must be at most ${QUESTION_MAX_LENGTH} characters` };
  }
  let authorName: string | null = null;
  if (input.authorName !== undefined && input.authorName !== null) {
    if (typeof input.authorName !== "string") return { ok: false, status: 400, error: "Invalid name" };
    const name = input.authorName.trim();
    if (name.length > AUTHOR_NAME_MAX_LENGTH) {
      return { ok: false, status: 400, error: `Name must be at most ${AUTHOR_NAME_MAX_LENGTH} characters` };
    }
    authorName = name || null;
  }
  if (isProfane(text) || (authorName && isProfane(authorName))) {
    return { ok: false, status: 400, error: "Please keep questions respectful" };
  }

  const db = getDb();
  const [event] = await db
    .select({ moderationMode: events.moderationMode })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) return { ok: false, status: 404, error: "Event not found" };
  const [participant] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.eventId, eventId)));
  if (!participant) return { ok: false, status: 404, error: "Event not found" };

  const status = event.moderationMode === "moderated" ? "pending" : "approved";
  const [row] = await db
    .insert(questions)
    .values({ eventId, participantId, text, authorName, status })
    .returning();
  const question = toPublicQuestion(row);

  if (status === "approved") publish(eventId, "question:added", { question });
  else publish(eventId, "question:pending", { question }, { hostOnly: true });

  return { ok: true, status, question };
}

/** Approved questions only: pinned first, then newest first. */
export async function listApprovedQuestions(eventId: string): Promise<PublicQuestion[]> {
  const rows = await getDb()
    .select()
    .from(questions)
    .where(and(eq(questions.eventId, eventId), eq(questions.status, "approved")))
    .orderBy(desc(questions.pinned), desc(questions.createdAt));
  return rows.map(toPublicQuestion);
}
