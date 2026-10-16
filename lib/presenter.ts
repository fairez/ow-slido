import { and, eq, inArray } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { pollConfig, type PollConfig, type PollOption } from "@/lib/polls";
import { getPollCounts } from "@/lib/votes";
import { listPresenterResponses, type PublicResponse } from "@/lib/open-text";
import { getPresenterResults, type RatingResults } from "@/lib/rating";
import { listPresenterNotes, type PublicNote } from "@/lib/shared-notes";
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

export type PresenterNotes = {
  type: "sharedNotes";
  id: string;
  title: string;
  state: "live" | "paused" | "closed";
  notes: PublicNote[];
};

export type PresenterOpenText = {
  type: "openText";
  id: string;
  title: string;
  state: "live" | "paused" | "closed";
  responses: PublicResponse[];
};

export type PresenterRating = {
  type: "rating";
  id: string;
  title: string;
  state: "live" | "paused" | "closed";
  results: RatingResults;
};

export type PresenterState = PresenterPoll | PresenterWordcloud | PresenterNotes | PresenterOpenText | PresenterRating;

/** The live interaction, or the shared-notes or open-text interaction named by `closedNotesId` once it has closed. */
export async function getPresenterState(eventId: string, closedNotesId?: string): Promise<PresenterState | null> {
  const db = getDb();
  let [row] = await db
    .select()
    .from(interactions)
    .where(and(eq(interactions.eventId, eventId), eq(interactions.state, "live")));
  if (!row && closedNotesId) {
    [row] = await db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.id, closedNotesId),
          eq(interactions.eventId, eventId),
          inArray(interactions.type, ["sharedNotes", "openText", "rating"]),
          eq(interactions.state, "closed"),
        ),
      );
  }
  if (!row) return null;
  if (row.type === "sharedNotes" && (row.state === "live" || row.state === "closed")) {
    return { type: "sharedNotes", id: row.id, title: row.title, state: row.state, notes: await listPresenterNotes(row.id) };
  }
  if (row.type === "openText" && (row.state === "live" || row.state === "closed")) {
    return { type: "openText", id: row.id, title: row.title, state: row.state, responses: await listPresenterResponses(row.id) };
  }
  if (row.type === "rating" && (row.state === "live" || row.state === "closed")) {
    return { type: "rating", id: row.id, title: row.title, state: row.state, results: await getPresenterResults(row.id, row.config) };
  }
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
