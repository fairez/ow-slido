import type { MessageKey, TParams } from "@/lib/i18n";
import { and, eq, ne, sql } from "drizzle-orm";
import { interactions, participants, quizAnswers } from "@/db/schema";
import { getDb } from "@/lib/db";
import { NICKNAME_MAX } from "@/lib/quiz-limits";
import { isProfane } from "@/lib/profanity";

export type NicknameResult =
  | { ok: true; nickname: string }
  | { ok: false; status: 400 | 404 | 409; error: MessageKey; params?: TParams };

/** Trims and collapses inner whitespace; null for anything that is not text. */
function cleanNickname(raw: unknown): string | null {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : null;
}

/** Validates a display name: 1 to 20 characters, no control characters, nothing on the profanity list. */
export function validateNickname(raw: unknown): NicknameResult {
  const nickname = cleanNickname(raw);
  if (!nickname) return { ok: false, status: 400, error: "api.nicknameEmpty" };
  if ([...nickname].length > NICKNAME_MAX) {
    return { ok: false, status: 400, error: "api.nicknameTooLong", params: { max: NICKNAME_MAX } };
  }
  if (/\p{C}/u.test(nickname)) return { ok: false, status: 400, error: "api.nicknameInvalid" };
  if (isProfane(nickname)) return { ok: false, status: 400, error: "api.nicknameBlocked" };
  return { ok: true, nickname };
}

/** True once the participant has answered any quiz question of the event; the name is fixed from then on. */
export async function hasAnsweredQuiz(eventId: string, participantId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ one: sql<number>`1` })
    .from(quizAnswers)
    .innerJoin(interactions, eq(interactions.id, quizAnswers.interactionId))
    .where(and(eq(quizAnswers.participantId, participantId), eq(interactions.eventId, eventId)))
    .limit(1);
  return Boolean(row);
}

/** The participant's nickname and whether it can still change, for the quiz screen. */
export async function getNicknameState(
  eventId: string,
  participantId: string | undefined,
): Promise<{ nickname: string | null; nicknameLocked: boolean }> {
  if (!participantId) return { nickname: null, nicknameLocked: false };
  const [row] = await getDb()
    .select({ nickname: participants.nickname })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.eventId, eventId)));
  return { nickname: row?.nickname ?? null, nicknameLocked: row ? await hasAnsweredQuiz(eventId, participantId) : false };
}

/**
 * Sets the participant's display name. It must be free in the event (ignoring case), and cannot change after
 * the first quiz answer. Saving the name the participant already has is allowed.
 */
export async function setNickname(eventId: string, participantId: string, raw: unknown): Promise<NicknameResult> {
  const valid = validateNickname(raw);
  if (!valid.ok) return valid;
  const db = getDb();
  const [me] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.eventId, eventId)));
  if (!me) return { ok: false, status: 404, error: "api.joinFirst" };
  if (await hasAnsweredQuiz(eventId, participantId)) return { ok: false, status: 409, error: "api.nicknameLocked" };

  const [taken] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(
      and(
        eq(participants.eventId, eventId),
        ne(participants.id, participantId),
        sql`lower(${participants.nickname}) = lower(${valid.nickname})`,
      ),
    );
  if (taken) return { ok: false, status: 409, error: "api.nicknameTaken" };

  try {
    await db.update(participants).set({ nickname: valid.nickname }).where(eq(participants.id, participantId));
  } catch (error) {
    // Two people chose the same name at once: the unique index decides.
    if ((error as { code?: string; cause?: { code?: string } }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505") {
      return { ok: false, status: 409, error: "api.nicknameTaken" };
    }
    throw error;
  }
  return valid;
}
