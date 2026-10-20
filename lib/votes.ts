import type { MessageKey, TParams } from "@/lib/i18n";
import { eq, sql } from "drizzle-orm";
import { interactions, participants, pollVotes } from "@/db/schema";
import { getDb } from "@/lib/db";
import { pollConfig, type PollConfig } from "@/lib/polls";
import { publish } from "@/lib/realtime/publisher";

export type PollCounts = { interactionId: string; counts: Record<string, number>; total: number };

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Votes per option id (every option present, zero if unvoted) and the number of voters. */
export async function getPollCounts(
  interactionId: string,
  optionIds: string[],
  db: Db | Tx = getDb(),
): Promise<PollCounts> {
  const rows = await db.execute<{ option_id: string; n: number }>(sql`
    select o.value as option_id, count(*)::int as n
    from ${pollVotes} v, jsonb_array_elements_text(v.option_ids) o(value)
    where v.interaction_id = ${interactionId}
    group by o.value`);
  const counts = Object.fromEntries(optionIds.map((id) => [id, 0]));
  for (const row of rows.rows) if (row.option_id in counts) counts[row.option_id] = row.n;
  const [{ total }] = (
    await db.execute<{ total: number }>(
      sql`select count(*)::int as total from ${pollVotes} where interaction_id = ${interactionId}`,
    )
  ).rows;
  return { interactionId, counts, total };
}

export type VoteResult =
  | { ok: true; counts: PollCounts }
  | { ok: false; status: 400 | 404 | 409; error: MessageKey; params?: TParams };

export async function castVote(
  interactionId: string,
  participantId: string,
  rawOptionIds: unknown,
): Promise<VoteResult> {
  const outcome = await getDb().transaction(async (tx): Promise<VoteResult & { eventId?: string }> => {
    // Share lock: closing (an UPDATE) waits for in-flight votes, so no vote lands after close.
    const [row] = await tx.select().from(interactions).where(eq(interactions.id, interactionId)).for("share");
    if (!row || row.type !== "poll") return { ok: false, status: 404, error: "api.interactionNotFound" };
    const [participant] = await tx
      .select({ eventId: participants.eventId })
      .from(participants)
      .where(eq(participants.id, participantId));
    if (!participant || participant.eventId !== row.eventId) {
      return { ok: false, status: 404, error: "api.interactionNotFound" };
    }
    if (row.state !== "live") return { ok: false, status: 409, error: "api.votingNotOpen" };

    const config = pollConfig(row.config as Partial<PollConfig>);
    const valid = new Set(config.options.map((o) => o.id));
    if (
      !Array.isArray(rawOptionIds) ||
      rawOptionIds.length === 0 ||
      !rawOptionIds.every((id) => typeof id === "string" && valid.has(id)) ||
      new Set(rawOptionIds).size !== rawOptionIds.length
    ) {
      return { ok: false, status: 400, error: "api.optionsInvalid" };
    }
    if (!config.multiSelect && rawOptionIds.length > 1) {
      return { ok: false, status: 400, error: "api.oneOption" };
    }

    const inserted = await tx
      .insert(pollVotes)
      .values({ interactionId, participantId, optionIds: rawOptionIds as string[] })
      .onConflictDoNothing()
      .returning({ id: pollVotes.id });
    if (inserted.length === 0) return { ok: false, status: 409, error: "api.alreadyVoted" };

    await tx
      .update(participants)
      .set({ firstResponseAt: sql`coalesce(${participants.firstResponseAt}, now())` })
      .where(eq(participants.id, participantId));
    const counts = await getPollCounts(interactionId, [...valid], tx);
    return { ok: true, counts, eventId: row.eventId };
  });

  if (outcome.ok && outcome.eventId) publish(outcome.eventId, "poll:counts", outcome.counts);
  return outcome.ok ? { ok: true, counts: outcome.counts } : outcome;
}
