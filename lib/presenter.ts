import { and, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { pollConfig, type PollConfig, type PollOption } from "@/lib/polls";
import { getPollCounts } from "@/lib/votes";

/** The live poll with its current tallies, for the presenter screen. */
export type PresenterState = {
  id: string;
  title: string;
  options: PollOption[];
  counts: Record<string, number>;
  total: number;
};

export async function getPresenterState(eventId: string): Promise<PresenterState | null> {
  const [row] = await getDb()
    .select()
    .from(interactions)
    .where(and(eq(interactions.eventId, eventId), eq(interactions.state, "live")));
  if (!row || row.type !== "poll") return null;
  const config = pollConfig(row.config as Partial<PollConfig>);
  const { counts, total } = await getPollCounts(
    row.id,
    config.options.map((o) => o.id),
  );
  return { id: row.id, title: row.title, options: config.options, counts, total };
}
