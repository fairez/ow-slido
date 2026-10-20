import { eq, sql } from "drizzle-orm";
import { quizAnswers } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { QuizConfig } from "@/lib/interaction-config";
import { QUIZ_TIME_DEFAULT } from "@/lib/quiz-limits";

/** The answer window in seconds, from a stored config (the default for a config without one). */
export function quizTimeLimitSeconds(config: unknown): number {
  const n = (config as Partial<QuizConfig> | null)?.timeLimitSeconds;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : QUIZ_TIME_DEFAULT;
}

/** Answers stored for a quiz question. */
export async function countQuizAnswers(interactionId: string): Promise<number> {
  const [r] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(quizAnswers)
    .where(eq(quizAnswers.interactionId, interactionId));
  return r?.n ?? 0;
}
