import { eq, sql } from "drizzle-orm";
import { quizAnswers, quizScores } from "@/db/schema";
import { getDb } from "@/lib/db";
import { MemoryLeaderboardStore } from "./memory";
import type { LeaderboardStore, ScoreDelta } from "./store";

export type { LeaderboardEntry, LeaderboardStore, ScoreDelta, ScoreRow } from "./store";
export { MemoryLeaderboardStore } from "./memory";

// Route handlers and server.ts may load separate module instances, so the store lives on globalThis.
const globalForStore = globalThis as unknown as { leaderboardStore?: LeaderboardStore };

export function getLeaderboardStore(): LeaderboardStore {
  return (globalForStore.leaderboardStore ??= new MemoryLeaderboardStore());
}

export function setLeaderboardStore(store: LeaderboardStore | null) {
  globalForStore.leaderboardStore = store ?? undefined;
}

type Db = Pick<ReturnType<typeof getDb>, "select" | "insert">;

/**
 * Adds the answers of a quiz question that just closed to the persisted totals, inside the closing
 * transaction. Returns what to add to the live store once that transaction has committed.
 */
export async function persistClosedQuestion(db: Db, eventId: string, interactionId: string): Promise<ScoreDelta[]> {
  const deltas = await db
    .select({
      participantId: quizAnswers.participantId,
      points: quizAnswers.points,
      elapsedMs: quizAnswers.elapsedMs,
      correct: quizAnswers.correct,
    })
    .from(quizAnswers)
    .where(eq(quizAnswers.interactionId, interactionId));
  if (deltas.length === 0) return [];
  await db
    .insert(quizScores)
    .values(
      deltas.map((d) => ({
        eventId,
        participantId: d.participantId,
        points: d.points,
        answeredCount: 1,
        correctCount: d.correct ? 1 : 0,
        totalElapsedMs: d.elapsedMs,
      })),
    )
    .onConflictDoUpdate({
      target: [quizScores.eventId, quizScores.participantId],
      set: {
        points: sql`${quizScores.points} + excluded.points`,
        answeredCount: sql`${quizScores.answeredCount} + 1`,
        correctCount: sql`${quizScores.correctCount} + excluded.correct_count`,
        totalElapsedMs: sql`${quizScores.totalElapsedMs} + excluded.total_elapsed_ms`,
      },
    });
  return deltas;
}

export async function applyScoreDeltas(eventId: string, deltas: readonly ScoreDelta[]) {
  const store = getLeaderboardStore();
  for (const delta of deltas) await store.add(eventId, delta);
}

/** Host reset: forgets every score of the event, in the table and in the live store. */
export async function resetLeaderboard(eventId: string) {
  await getDb().delete(quizScores).where(eq(quizScores.eventId, eventId));
  await getLeaderboardStore().reset(eventId);
}

/** Loads every persisted total into the live store; run once when the server starts. */
export async function rebuildLeaderboard(store: LeaderboardStore = getLeaderboardStore()) {
  const rows = await getDb().select().from(quizScores);
  await store.replaceAll(
    rows.map((r) => ({
      eventId: r.eventId,
      participantId: r.participantId,
      points: r.points,
      answeredCount: r.answeredCount,
      totalElapsedMs: r.totalElapsedMs,
    })),
  );
  return rows.length;
}
