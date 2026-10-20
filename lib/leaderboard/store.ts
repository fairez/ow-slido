/** One participant's running total in an event. */
export type ScoreRow = {
  participantId: string;
  points: number;
  /** Closed questions the participant answered. */
  answeredCount: number;
  /** Time spent answering those questions; the tie-break. */
  totalElapsedMs: number;
};

export type LeaderboardEntry = ScoreRow & {
  /** 1-based; participants with equal points and equal total time share a rank. */
  rank: number;
};

export type ScoreDelta = { participantId: string; points: number; elapsedMs: number };

/**
 * Live quiz scores per event. The in-memory adapter is the only one for now; a Redis sorted set can
 * implement the same methods later. Totals are persisted in `quiz_scores` by the caller, and the store
 * is rebuilt from that table (`replaceAll`) when the server starts.
 */
export interface LeaderboardStore {
  /** Adds one answered question to a participant's total (points, +1 answered, elapsed time). */
  add(eventId: string, delta: ScoreDelta): Promise<void>;
  /** The best `n` participants, best first. */
  top(eventId: string, n: number): Promise<LeaderboardEntry[]>;
  /** One participant's entry with their rank, or null when they have answered nothing yet. */
  rankOf(eventId: string, participantId: string): Promise<LeaderboardEntry | null>;
  /** Number of ranked participants. */
  size(eventId: string): Promise<number>;
  /** Drops every score of one event. */
  reset(eventId: string): Promise<void>;
  /** Replaces everything the store holds with these rows (startup rebuild). */
  replaceAll(rows: readonly (ScoreRow & { eventId: string })[]): Promise<void>;
}

/** Points first, then less total time; participantId only keeps the order stable. */
export function compareScores(a: ScoreRow, b: ScoreRow): number {
  return (
    b.points - a.points ||
    a.totalElapsedMs - b.totalElapsedMs ||
    (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0)
  );
}

/** Ranks an already sorted list: a row shares the rank of the previous one when points and time are equal. */
export function assignRanks(sorted: readonly ScoreRow[]): LeaderboardEntry[] {
  const out: LeaderboardEntry[] = [];
  sorted.forEach((row, i) => {
    const prev = out[i - 1];
    const tied = prev && prev.points === row.points && prev.totalElapsedMs === row.totalElapsedMs;
    out.push({ ...row, rank: tied ? prev.rank : i + 1 });
  });
  return out;
}
