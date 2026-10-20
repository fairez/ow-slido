import type { MessageKey, TParams } from "@/lib/i18n";
import { asc, desc, eq, sql } from "drizzle-orm";
import { interactions, participants, surveyAnswers, surveySubmissions } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { SurveyQuestion } from "@/lib/interaction-config";
import { isProfane } from "@/lib/profanity";
import { publish } from "@/lib/realtime/publisher";
import { RATING_SCALE_MAX } from "@/lib/rating-limits";
import { SURVEY_ANSWER_MAX } from "@/lib/survey-limits";

export type SurveyValue = string[] | number | string;

/** How many of the newest open-text answers a question's results list. */
export const SURVEY_LATEST_ANSWERS = 20;

type Db = Pick<ReturnType<typeof getDb>, "select">;

export const questionsOf = (config: unknown): SurveyQuestion[] => {
  const raw = ((config ?? {}) as { questions?: unknown }).questions;
  return Array.isArray(raw) ? (raw as SurveyQuestion[]) : [];
};

type Checked = { ok: true; value: SurveyValue | null } | { ok: false; error: MessageKey; params?: TParams };

/** Validates one answer against its question; `null` means "left blank" (an empty text or an empty selection). */
export function checkAnswer(question: SurveyQuestion, raw: unknown): Checked {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (question.kind === "openText") {
    if (typeof raw !== "string") return { ok: false, error: "api.surveyAnswerInvalid" };
    const text = raw.trim();
    if (!text) return { ok: true, value: null };
    if (text.length > SURVEY_ANSWER_MAX) return { ok: false, error: "api.surveyAnswerMax", params: { max: SURVEY_ANSWER_MAX } };
    if (isProfane(text)) return { ok: false, error: "api.profaneResponse" };
    return { ok: true, value: text };
  }
  if (question.kind === "rating") {
    const max = RATING_SCALE_MAX[question.scale ?? "stars5"];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > max) return { ok: false, error: "api.surveyAnswerInvalid" };
    return { ok: true, value: raw };
  }
  if (!Array.isArray(raw)) return { ok: false, error: "api.surveyAnswerInvalid" };
  if (raw.length === 0) return { ok: true, value: null };
  const known = new Set((question.options ?? []).map((o) => o.id));
  const picked = new Set<string>();
  for (const id of raw) {
    if (typeof id !== "string" || !known.has(id) || picked.has(id)) return { ok: false, error: "api.surveyAnswerInvalid" };
    picked.add(id);
  }
  if (!question.multiple && picked.size !== 1) return { ok: false, error: "api.surveyAnswerInvalid" };
  return { ok: true, value: [...picked] };
}

export type ValidatedAnswers =
  | { ok: true; answers: Map<string, SurveyValue> }
  | { ok: false; error: MessageKey; params?: TParams; questionId?: string; missing?: string[] };

/**
 * Checks a whole `{questionId: value}` body. Every required question must be answered; the first bad answer
 * is reported with its question id, and so is every missing required one.
 */
export function validateAnswers(questions: readonly SurveyQuestion[], raw: unknown): ValidatedAnswers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "api.surveyAnswersInvalid" };
  const body = raw as Record<string, unknown>;
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const id of Object.keys(body)) {
    if (!byId.has(id)) return { ok: false, error: "api.surveyUnknownQuestion", questionId: id };
  }
  const answers = new Map<string, SurveyValue>();
  const missing: string[] = [];
  for (const q of questions) {
    const checked = checkAnswer(q, body[q.id]);
    if (!checked.ok) return { ok: false, error: checked.error, params: checked.params, questionId: q.id };
    if (checked.value === null) {
      if (q.required) missing.push(q.id);
    } else answers.set(q.id, checked.value);
  }
  if (missing.length) return { ok: false, error: "api.surveyRequired", questionId: missing[0], missing };
  return { ok: true, answers };
}

export type ChoiceResult = { id: string; text: string; count: number; percent: number };
export type QuestionResult = {
  id: string;
  kind: SurveyQuestion["kind"];
  text: string;
  required: boolean;
  /** Submissions that answered this question. */
  answered: number;
} & (
  | { kind: "choice"; multiple: boolean; options: ChoiceResult[] }
  | { kind: "rating"; scale: "stars5" | "numeric10"; average: number | null; distribution: number[] }
  | { kind: "openText"; latest: string[] }
);

export type SurveyResults = {
  interactionId: string;
  /** Submitted surveys. */
  total: number;
  /** Submissions that answered every question. */
  completed: number;
  questions: QuestionResult[];
};

const percentOf = (count: number, of: number) => (of === 0 ? 0 : Math.round((count / of) * 1000) / 10);

/** Aggregates only: no participant or submission ids leave this function. */
export async function computeSurveyResults(db: Db, interactionId: string, config: unknown): Promise<SurveyResults> {
  const questions = questionsOf(config);
  const rows = await db
    .select({ submissionId: surveyAnswers.submissionId, questionId: surveyAnswers.questionId, value: surveyAnswers.value, at: surveySubmissions.createdAt })
    .from(surveyAnswers)
    .innerJoin(surveySubmissions, eq(surveySubmissions.id, surveyAnswers.submissionId))
    .where(eq(surveySubmissions.interactionId, interactionId))
    .orderBy(desc(surveySubmissions.createdAt), desc(surveySubmissions.id));
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(surveySubmissions)
    .where(eq(surveySubmissions.interactionId, interactionId));

  const byQuestion = new Map<string, { submissionId: string; value: SurveyValue }[]>();
  const answeredBy = new Map<string, number>();
  for (const r of rows) {
    const list = byQuestion.get(r.questionId) ?? [];
    list.push({ submissionId: r.submissionId, value: r.value });
    byQuestion.set(r.questionId, list);
    answeredBy.set(r.submissionId, (answeredBy.get(r.submissionId) ?? 0) + 1);
  }
  let completed = 0;
  if (questions.length) for (const n of answeredBy.values()) if (n >= questions.length) completed += 1;

  const results = questions.map((q): QuestionResult => {
    const answers = byQuestion.get(q.id) ?? [];
    const base = { id: q.id, text: q.text, required: q.required, answered: answers.length };
    if (q.kind === "choice") {
      const counts = new Map<string, number>();
      for (const a of answers) for (const id of a.value as string[]) counts.set(id, (counts.get(id) ?? 0) + 1);
      return {
        ...base,
        kind: "choice",
        multiple: q.multiple === true,
        options: (q.options ?? []).map((o) => ({ id: o.id, text: o.text, count: counts.get(o.id) ?? 0, percent: percentOf(counts.get(o.id) ?? 0, answers.length) })),
      };
    }
    if (q.kind === "rating") {
      const scale = q.scale ?? "stars5";
      const distribution = new Array<number>(RATING_SCALE_MAX[scale]).fill(0);
      let sum = 0;
      for (const a of answers) {
        distribution[(a.value as number) - 1] += 1;
        sum += a.value as number;
      }
      return { ...base, kind: "rating", scale, average: answers.length ? Math.round((sum / answers.length) * 100) / 100 : null, distribution };
    }
    return { ...base, kind: "openText", latest: answers.slice(0, SURVEY_LATEST_ANSWERS).map((a) => a.value as string) };
  });
  return { interactionId, total, completed, questions: results };
}

/** One entry per submission, oldest first, as `{questionId: value}`; no ids of people. */
export async function listSubmissions(db: Db, interactionId: string): Promise<Map<string, SurveyValue>[]> {
  const rows = await db
    .select({ submissionId: surveyAnswers.submissionId, questionId: surveyAnswers.questionId, value: surveyAnswers.value })
    .from(surveySubmissions)
    .leftJoin(surveyAnswers, eq(surveyAnswers.submissionId, surveySubmissions.id))
    .where(eq(surveySubmissions.interactionId, interactionId))
    .orderBy(asc(surveySubmissions.createdAt), asc(surveySubmissions.id));
  const bySubmission = new Map<string, Map<string, SurveyValue>>();
  for (const r of rows) {
    const answers = bySubmission.get(r.submissionId ?? "") ?? new Map<string, SurveyValue>();
    if (r.questionId !== null && r.value !== null) answers.set(r.questionId, r.value);
    bySubmission.set(r.submissionId ?? "", answers);
  }
  return [...bySubmission.values()];
}

export async function countSurveySubmissions(interactionId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(surveySubmissions)
    .where(eq(surveySubmissions.interactionId, interactionId));
  return row?.n ?? 0;
}

export type SubmitSurveyResult =
  | { ok: true; results: SurveyResults }
  | { ok: false; status: 400 | 404 | 409; error: MessageKey; params?: TParams; questionId?: string; missing?: string[] };

export async function submitSurvey(interactionId: string, participantId: string, rawAnswers: unknown): Promise<SubmitSurveyResult> {
  type Failure = Extract<SubmitSurveyResult, { ok: false }>;
  type Outcome = { failure: Failure } | { failure?: undefined; eventId: string; config: unknown };
  const fail = (status: Failure["status"], error: MessageKey, extra: Partial<Failure> = {}): { failure: Failure } => ({
    failure: { ok: false, status, error, ...extra },
  });
  const outcome: Outcome = await getDb().transaction(async (tx): Promise<Outcome> => {
    // Share lock: closing (an UPDATE) waits for in-flight writes.
    const [interaction] = await tx.select().from(interactions).where(eq(interactions.id, interactionId)).for("share");
    if (!interaction || interaction.type !== "survey") return fail(404, "api.interactionNotFound");
    const [participant] = await tx
      .select({ eventId: participants.eventId })
      .from(participants)
      .where(eq(participants.id, participantId));
    if (!participant || participant.eventId !== interaction.eventId) return fail(404, "api.interactionNotFound");
    if (interaction.state !== "live") return fail(409, "api.surveyNotOpen");

    const checked = validateAnswers(questionsOf(interaction.config), rawAnswers);
    if (!checked.ok) return { failure: { ...checked, status: 400 } };

    const [submission] = await tx
      .insert(surveySubmissions)
      .values({ interactionId, participantId })
      .onConflictDoNothing()
      .returning({ id: surveySubmissions.id });
    if (!submission) return fail(409, "api.alreadySubmitted");
    if (checked.answers.size) {
      await tx
        .insert(surveyAnswers)
        .values([...checked.answers].map(([questionId, value]) => ({ submissionId: submission.id, questionId, value })));
    }
    await tx
      .update(participants)
      .set({ firstResponseAt: sql`coalesce(${participants.firstResponseAt}, now())` })
      .where(eq(participants.id, participantId));
    return { eventId: interaction.eventId, config: interaction.config };
  });

  if (outcome.failure) return outcome.failure;
  const results = await computeSurveyResults(getDb(), interactionId, outcome.config);
  publish(outcome.eventId, "survey:results", { results }, { hostOnly: true });
  return { ok: true, results };
}
