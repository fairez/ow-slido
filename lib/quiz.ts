import type { MessageKey, TParams } from "@/lib/i18n";
import { and, eq, sql } from "drizzle-orm";
import { interactions, participants, quizAnswers } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { QuizConfig } from "@/lib/interaction-config";
import { ownStanding, type OwnStanding } from "@/lib/leaderboard/standings";
import { QUIZ_POINTS_DEFAULT, QUIZ_TIME_DEFAULT } from "@/lib/quiz-limits";
import { publish } from "@/lib/realtime/publisher";

/** The answer window in seconds, from a stored config (the default for a config without one). */
export function quizTimeLimitSeconds(config: unknown): number {
  const n = (config as Partial<QuizConfig> | null)?.timeLimitSeconds;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : QUIZ_TIME_DEFAULT;
}

const quizPoints = (config: unknown): number => {
  const n = (config as Partial<QuizConfig> | null)?.points;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : QUIZ_POINTS_DEFAULT;
};

const GRACE_DEFAULT_MS = 300;

/** Answers that arrive this long after `deadline_at` still count (network latency); env `QUIZ_GRACE_MS`. */
export function quizGraceMs(): number {
  const n = Number(process.env.QUIZ_GRACE_MS);
  return process.env.QUIZ_GRACE_MS !== undefined && Number.isFinite(n) && n >= 0 ? Math.floor(n) : GRACE_DEFAULT_MS;
}

/**
 * Points for one answer: 0 when wrong, otherwise `points` scaled linearly from 100% at the start of the
 * window down to 50% at the deadline (an answer inside the grace period earns the 50%).
 */
export function scoreQuizAnswer(a: { correct: boolean; elapsedMs: number; timeLimitMs: number; points: number }): number {
  if (!a.correct) return 0;
  const used = a.timeLimitMs > 0 ? Math.min(1, Math.max(0, a.elapsedMs / a.timeLimitMs)) : 1;
  return Math.round(a.points * (1 - 0.5 * used));
}

/** True when the selected ids are exactly the correct ids (order and repeats ignored). */
export function isCorrectSelection(selected: readonly string[], correct: readonly string[]): boolean {
  const want = new Set(correct);
  const got = new Set(selected);
  return got.size === want.size && [...got].every((id) => want.has(id));
}

export type QuizOptionResult = { id: string; text: string; correct: boolean; count: number };

export type QuizResults = {
  interactionId: string;
  /** Answers stored. */
  total: number;
  /** Options in the host's order; `count` is how many answers selected the option. */
  options: QuizOptionResult[];
  /** Share of answers that were correct, 0-100 rounded; null before the first answer. */
  correctPercent: number | null;
};

type Db = Pick<ReturnType<typeof getDb>, "select">;

export async function computeQuizResults(db: Db, interactionId: string, config: unknown): Promise<QuizResults> {
  const c = (config ?? {}) as Partial<QuizConfig>;
  const rows = await db
    .select({ optionIds: quizAnswers.optionIds, correct: quizAnswers.correct })
    .from(quizAnswers)
    .where(eq(quizAnswers.interactionId, interactionId));
  const counts = new Map<string, number>();
  for (const r of rows) for (const id of new Set(r.optionIds)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const correct = new Set(c.correctOptionIds ?? []);
  const right = rows.filter((r) => r.correct).length;
  return {
    interactionId,
    total: rows.length,
    options: (Array.isArray(c.options) ? c.options : []).map((o) => ({
      id: o.id,
      text: o.text,
      correct: correct.has(o.id),
      count: counts.get(o.id) ?? 0,
    })),
    correctPercent: rows.length === 0 ? null : Math.round((right / rows.length) * 100),
  };
}

/** Answers stored for a quiz question. */
export async function countQuizAnswers(interactionId: string): Promise<number> {
  const [r] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(quizAnswers)
    .where(eq(quizAnswers.interactionId, interactionId));
  return r?.n ?? 0;
}

export type QuizOutcome = {
  answered: boolean;
  optionIds: string[];
  correct: boolean;
  points: number;
  correctOptionIds: string[];
  /** The participant's cumulative rank and points in the event, null while they have none ranked. */
  standing: OwnStanding | null;
};

/** What one participant got for a closed question. The correct options are only revealed after close. */
export async function getQuizOutcome(interactionId: string, participantId: string): Promise<QuizOutcome | null> {
  const db = getDb();
  const [interaction] = await db.select().from(interactions).where(eq(interactions.id, interactionId));
  if (!interaction || interaction.type !== "quiz" || interaction.state !== "closed") return null;
  const [answer] = await db
    .select({ optionIds: quizAnswers.optionIds, correct: quizAnswers.correct, points: quizAnswers.points })
    .from(quizAnswers)
    .where(and(eq(quizAnswers.interactionId, interactionId), eq(quizAnswers.participantId, participantId)));
  return {
    answered: Boolean(answer),
    optionIds: answer?.optionIds ?? [],
    correct: answer?.correct ?? false,
    points: answer?.points ?? 0,
    correctOptionIds: (interaction.config as Partial<QuizConfig>).correctOptionIds ?? [],
    standing: await ownStanding(interaction.eventId, participantId),
  };
}

/** The database clock as epoch ms; the countdown compares it with `deadline_at`, which the database wrote. */
export async function databaseNowMs(): Promise<number> {
  const { rows } = await getDb().execute<{ ms: string }>(sql`select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms`);
  return Number(rows[0].ms);
}

export type SubmitQuizResult =
  | { ok: true; results: QuizResults }
  | { ok: false; status: 400 | 404 | 409; error: MessageKey; params?: TParams };

/**
 * Stores a participant's answer. The server clock decides: the window is `started_at` to `deadline_at`
 * (both written by the database when the question started) plus the grace period.
 */
export async function submitQuizAnswer(
  interactionId: string,
  participantId: string,
  rawOptionIds: unknown,
): Promise<SubmitQuizResult> {
  type Outcome =
    | { error: 400 | 404 | 409; message: MessageKey }
    | { error?: undefined; eventId: string; config: unknown };
  const grace = quizGraceMs();
  const outcome: Outcome = await getDb().transaction(async (tx): Promise<Outcome> => {
    // Share lock: closing or pausing (an UPDATE) waits for in-flight answers.
    const [interaction] = await tx.select().from(interactions).where(eq(interactions.id, interactionId)).for("share");
    if (!interaction || interaction.type !== "quiz") return { error: 404 as const, message: "api.interactionNotFound" };
    const [participant] = await tx
      .select({ eventId: participants.eventId })
      .from(participants)
      .where(eq(participants.id, participantId));
    if (!participant || participant.eventId !== interaction.eventId) {
      return { error: 404 as const, message: "api.interactionNotFound" };
    }
    if (interaction.state !== "live" || !interaction.startedAt || !interaction.deadlineAt) {
      return { error: 409 as const, message: "api.questionNotOpen" };
    }
    const config = interaction.config as Partial<QuizConfig>;
    const optionIds = new Set((config.options ?? []).map((o) => o.id));
    if (
      !Array.isArray(rawOptionIds) ||
      rawOptionIds.length === 0 ||
      new Set(rawOptionIds).size !== rawOptionIds.length ||
      !rawOptionIds.every((id) => typeof id === "string" && optionIds.has(id))
    ) {
      return { error: 400 as const, message: "api.quizAnswerInvalid" };
    }
    const selected = rawOptionIds as string[];

    // clock_timestamp(), not now(): now() is the start of the transaction, which may have waited on a lock.
    const { rows: [clock] } = await tx.execute<{ elapsed_ms: number; late: boolean }>(sql`
      select (extract(epoch from clock_timestamp() - started_at) * 1000)::int as elapsed_ms,
             clock_timestamp() > deadline_at + make_interval(secs => ${grace / 1000}) as late
      from interactions where id = ${interactionId}`);
    if (clock.late) return { error: 409 as const, message: "api.quizTimeUp" };

    const elapsedMs = Math.max(0, clock.elapsed_ms);
    const correct = isCorrectSelection(selected, config.correctOptionIds ?? []);
    const points = scoreQuizAnswer({
      correct,
      elapsedMs,
      timeLimitMs: quizTimeLimitSeconds(config) * 1000,
      points: quizPoints(config),
    });
    const inserted = await tx
      .insert(quizAnswers)
      .values({ interactionId, participantId, optionIds: selected, elapsedMs, correct, points })
      .onConflictDoNothing()
      .returning({ id: quizAnswers.id });
    if (inserted.length === 0) return { error: 409 as const, message: "api.alreadyAnswered" };
    await tx
      .update(participants)
      .set({ firstResponseAt: sql`coalesce(${participants.firstResponseAt}, now())` })
      .where(eq(participants.id, participantId));
    return { eventId: interaction.eventId, config: interaction.config };
  });

  if (outcome.error) return { ok: false, status: outcome.error, error: outcome.message };
  const results = await computeQuizResults(getDb(), interactionId, outcome.config);
  publish(outcome.eventId, "quiz:results", { results }, { hostOnly: true });
  return { ok: true, results };
}
