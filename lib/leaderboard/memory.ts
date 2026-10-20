import { type LeaderboardEntry, type LeaderboardStore, type ScoreDelta, type ScoreRow, assignRanks, compareScores } from "./store";

export class MemoryLeaderboardStore implements LeaderboardStore {
  private events = new Map<string, Map<string, ScoreRow>>();

  async add(eventId: string, delta: ScoreDelta) {
    let rows = this.events.get(eventId);
    if (!rows) this.events.set(eventId, (rows = new Map()));
    const row = rows.get(delta.participantId) ?? {
      participantId: delta.participantId,
      points: 0,
      answeredCount: 0,
      totalElapsedMs: 0,
    };
    rows.set(delta.participantId, {
      ...row,
      points: row.points + delta.points,
      answeredCount: row.answeredCount + 1,
      totalElapsedMs: row.totalElapsedMs + delta.elapsedMs,
    });
  }

  private ranked(eventId: string): LeaderboardEntry[] {
    return assignRanks([...(this.events.get(eventId)?.values() ?? [])].sort(compareScores));
  }

  async top(eventId: string, n: number) {
    return this.ranked(eventId).slice(0, Math.max(0, n));
  }

  async rankOf(eventId: string, participantId: string) {
    return this.ranked(eventId).find((e) => e.participantId === participantId) ?? null;
  }

  async size(eventId: string) {
    return this.events.get(eventId)?.size ?? 0;
  }

  async reset(eventId: string) {
    this.events.delete(eventId);
  }

  async replaceAll(rows: readonly (ScoreRow & { eventId: string })[]) {
    this.events.clear();
    for (const { eventId, ...row } of rows) {
      let byParticipant = this.events.get(eventId);
      if (!byParticipant) this.events.set(eventId, (byParticipant = new Map()));
      byParticipant.set(row.participantId, row);
    }
  }
}
