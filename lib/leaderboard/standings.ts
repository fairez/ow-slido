import { and, eq, inArray } from "drizzle-orm";
import { participants, quizScores } from "@/db/schema";
import { getDb } from "@/lib/db";
import { getLeaderboardStore } from "./index";
import { assignRanks, compareScores } from "./store";

/** A leaderboard row for the screens. Nicknames are display names; participant ids stay server side. */
export type Standing = {
  rank: number;
  /** Null for a participant who never picked a name; the screen shows a fallback label. */
  nickname: string | null;
  points: number;
};

export type OwnStanding = { rank: number; points: number; players: number };

/** How many rows the presenter shows after each question. */
export const LEADERBOARD_TOP = 10;
export const PODIUM_SIZE = 3;

/** The best `n` participants of the event from the live store, best first. */
export async function topStandings(eventId: string, n: number): Promise<Standing[]> {
  const entries = await getLeaderboardStore().top(eventId, n);
  if (entries.length === 0) return [];
  const names = await getDb()
    .select({ id: participants.id, nickname: participants.nickname })
    .from(participants)
    .where(and(eq(participants.eventId, eventId), inArray(participants.id, entries.map((e) => e.participantId))));
  const nameOf = new Map(names.map((r) => [r.id, r.nickname]));
  return entries.map((e) => ({ rank: e.rank, nickname: nameOf.get(e.participantId) ?? null, points: e.points }));
}

/** One participant's rank and total, or null while they have no closed question answered. */
export async function ownStanding(eventId: string, participantId: string): Promise<OwnStanding | null> {
  const store = getLeaderboardStore();
  const entry = await store.rankOf(eventId, participantId);
  if (!entry) return null;
  return { rank: entry.rank, points: entry.points, players: await store.size(eventId) };
}

/** Every ranked participant with their correct answers, from the persisted totals; the CSV export reads this. */
export async function allStandings(eventId: string): Promise<(Standing & { correct: number })[]> {
  const rows = await getDb()
    .select({
      participantId: quizScores.participantId,
      points: quizScores.points,
      answeredCount: quizScores.answeredCount,
      totalElapsedMs: quizScores.totalElapsedMs,
      correct: quizScores.correctCount,
      nickname: participants.nickname,
    })
    .from(quizScores)
    .innerJoin(participants, eq(participants.id, quizScores.participantId))
    .where(eq(quizScores.eventId, eventId));
  const byId = new Map(rows.map((r) => [r.participantId, r]));
  return assignRanks([...rows].sort(compareScores)).map((e) => {
    const row = byId.get(e.participantId)!;
    return { rank: e.rank, nickname: row.nickname, points: e.points, correct: row.correct };
  });
}
