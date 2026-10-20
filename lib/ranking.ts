import type { MessageKey, TParams } from "@/lib/i18n";
import { eq, sql } from "drizzle-orm";
import { interactions, participants, rankingResponses } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { RankingOption } from "@/lib/interaction-config";
import { publish } from "@/lib/realtime/publisher";

export type RankingScore = {
  id: string;
  text: string;
  /** First place earns N points (N = number of options), last place 1. */
  score: number;
  /** 1-based; options with the same score share a rank and the next rank is skipped. */
  rank: number;
};

export type RankingResults = {
  interactionId: string;
  /** Submitted rankings. */
  total: number;
  /** Best score first; ties keep the order the host gave the options. */
  options: RankingScore[];
};

const optionsOf = (config: unknown): RankingOption[] => {
  const raw = ((config ?? {}) as { options?: unknown }).options;
  return Array.isArray(raw) ? (raw as RankingOption[]) : [];
};

/**
 * Points per option from submitted orders (option ids, first place first). A response may be partial: only the
 * positions it lists score, ids that are not options (or repeat inside one response) are ignored.
 */
export function scoreRanking(options: readonly RankingOption[], responses: readonly (readonly string[])[]): RankingScore[] {
  const n = options.length;
  const points = new Map(options.map((o) => [o.id, 0]));
  for (const order of responses) {
    const used = new Set<string>();
    order.forEach((id, index) => {
      if (!points.has(id) || used.has(id) || index >= n) return;
      used.add(id);
      points.set(id, points.get(id)! + (n - index));
    });
  }
  const sorted = options
    .map((o, position) => ({ id: o.id, text: o.text, score: points.get(o.id)!, position }))
    .sort((a, b) => b.score - a.score || a.position - b.position);
  const scored: RankingScore[] = [];
  sorted.forEach((o, i) => {
    const tied = i > 0 && scored[i - 1].score === o.score;
    scored.push({ id: o.id, text: o.text, score: o.score, rank: tied ? scored[i - 1].rank : i + 1 });
  });
  return scored;
}

type Db = Pick<ReturnType<typeof getDb>, "select">;

export async function computeResults(db: Db, interactionId: string, config: unknown): Promise<RankingResults> {
  const rows = await db
    .select({ order: rankingResponses.order })
    .from(rankingResponses)
    .where(eq(rankingResponses.interactionId, interactionId));
  return {
    interactionId,
    total: rows.length,
    options: scoreRanking(optionsOf(config), rows.map((r) => r.order)),
  };
}

export type SubmitRankingResult =
  | { ok: true; results: RankingResults }
  | { ok: false; status: 400 | 404 | 409; error: MessageKey; params?: TParams };

/** True when `order` lists every option id exactly once. */
export function isPermutation(order: unknown, options: readonly RankingOption[]): order is string[] {
  if (!Array.isArray(order) || order.length !== options.length) return false;
  const ids = new Set(options.map((o) => o.id));
  const seen = new Set<unknown>();
  for (const id of order) {
    if (typeof id !== "string" || !ids.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

export async function submitRanking(
  interactionId: string,
  participantId: string,
  rawOrder: unknown,
): Promise<SubmitRankingResult> {
  type Outcome =
    | { error: 400 | 404 | 409; message: MessageKey }
    | { error?: undefined; eventId: string; config: unknown };
  const outcome: Outcome = await getDb().transaction(async (tx): Promise<Outcome> => {
    // Share lock: closing (an UPDATE) waits for in-flight writes.
    const [interaction] = await tx.select().from(interactions).where(eq(interactions.id, interactionId)).for("share");
    if (!interaction || interaction.type !== "ranking") return { error: 404 as const, message: "api.interactionNotFound" };
    const [participant] = await tx
      .select({ eventId: participants.eventId })
      .from(participants)
      .where(eq(participants.id, participantId));
    if (!participant || participant.eventId !== interaction.eventId) {
      return { error: 404 as const, message: "api.interactionNotFound" };
    }
    if (interaction.state !== "live") return { error: 409 as const, message: "api.questionNotOpen" };
    if (!isPermutation(rawOrder, optionsOf(interaction.config))) {
      return { error: 400 as const, message: "api.rankingOrderInvalid" };
    }

    const inserted = await tx
      .insert(rankingResponses)
      .values({ interactionId, participantId, order: rawOrder })
      .onConflictDoNothing()
      .returning({ id: rankingResponses.id });
    if (inserted.length === 0) return { error: 409 as const, message: "api.alreadyRanked" };
    await tx
      .update(participants)
      .set({ firstResponseAt: sql`coalesce(${participants.firstResponseAt}, now())` })
      .where(eq(participants.id, participantId));
    return { eventId: interaction.eventId, config: interaction.config };
  });

  if (outcome.error) return { ok: false, status: outcome.error, error: outcome.message };
  const results = await computeResults(getDb(), interactionId, outcome.config);
  publish(outcome.eventId, "ranking:results", { results }, { hostOnly: true });
  return { ok: true, results };
}
