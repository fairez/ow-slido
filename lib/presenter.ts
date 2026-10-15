import { and, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { pollConfig, type PollConfig, type PollOption } from "@/lib/polls";
import { getPollCounts } from "@/lib/votes";
import { getWordcloudResults, type WordCount } from "@/lib/wordclouds";

/** The live poll with its current tallies, for the presenter screen. */
export type PresenterPoll = {
  type: "poll";
  id: string;
  title: string;
  options: PollOption[];
  counts: Record<string, number>;
  total: number;
};

export type PresenterWordcloud = { type: "wordcloud"; id: string; title: string; words: WordCount[]; total: number };

export type PresenterState = PresenterPoll | PresenterWordcloud;

export async function getPresenterState(eventId: string): Promise<PresenterState | null> {
  const [row] = await getDb()
    .select()
    .from(interactions)
    .where(and(eq(interactions.eventId, eventId), eq(interactions.state, "live")));
  if (!row) return null;
  if (row.type === "wordcloud") {
    const { words, total } = await getWordcloudResults(row.id);
    return { type: "wordcloud", id: row.id, title: row.title, words, total };
  }
  if (row.type !== "poll") return null;
  const config = pollConfig(row.config as Partial<PollConfig>);
  const { counts, total } = await getPollCounts(
    row.id,
    config.options.map((o) => o.id),
  );
  return { type: "poll", id: row.id, title: row.title, options: config.options, counts, total };
}
