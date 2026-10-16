import { and, eq, sql } from "drizzle-orm";
import { interactions, openTextResponses, ratingResponses, sharedNotes, wordcloudEntries } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { OpenTextConfig, RatingConfig, SharedNotesConfig } from "@/lib/interaction-config";
import { pollConfig, type PollConfig, type PollOption } from "@/lib/polls";
import { wordcloudConfig, type WordcloudConfig } from "@/lib/wordclouds";

/** What a participant may see of the live interaction; host-only settings are left out. */
export type LivePoll = {
  id: string;
  type: "poll";
  title: string;
  state: "live" | "closed";
  options: PollOption[];
  multiSelect: boolean;
  /** Whether the participant may see vote counts; the client must not show them otherwise. */
  showResultsToParticipants: boolean;
};

export type LiveWordcloud = {
  id: string;
  type: "wordcloud";
  title: string;
  state: "live" | "closed";
  maxEntries: number;
  /** Entries this participant may still submit; equals maxEntries when the participant is unknown. */
  remaining: number;
};

export type LiveNotes = {
  id: string;
  type: "sharedNotes";
  title: string;
  state: "live" | "closed";
  maxNotes: number;
  /** Notes this participant may still write; equals maxNotes when the participant is unknown. */
  remaining: number;
  moderation: "open" | "moderated";
  showAuthorNames: boolean;
};

export type LiveOpenText = {
  id: string;
  type: "openText";
  title: string;
  state: "live" | "closed";
  maxResponses: number;
  /** Responses this participant may still send; equals maxResponses when the participant is unknown. */
  remaining: number;
};

export type LiveRating = {
  id: string;
  type: "rating";
  title: string;
  state: "live" | "closed";
  scale: RatingConfig["scale"];
  /** This participant's earlier rating, or null; ratings cannot be changed. */
  mine: number | null;
};

export type LiveInteraction = LivePoll | LiveWordcloud | LiveNotes | LiveOpenText | LiveRating;

export async function getLiveInteraction(
  eventId: string,
  participantId?: string,
): Promise<LiveInteraction | null> {
  const [row] = await getDb()
    .select()
    .from(interactions)
    .where(and(eq(interactions.eventId, eventId), eq(interactions.state, "live")));
  if (!row) return null;
  if (row.type === "wordcloud") {
    const { maxEntriesPerParticipant: max } = wordcloudConfig(row.config as Partial<WordcloudConfig>, row.title);
    let used = 0;
    if (participantId) {
      const [r] = await getDb()
        .select({ used: sql<number>`count(*)::int` })
        .from(wordcloudEntries)
        .where(and(eq(wordcloudEntries.interactionId, row.id), eq(wordcloudEntries.participantId, participantId)));
      used = r.used;
    }
    return { id: row.id, type: "wordcloud", title: row.title, state: "live", maxEntries: max, remaining: Math.max(0, max - used) };
  }
  if (row.type === "sharedNotes") {
    const c = row.config as Partial<SharedNotesConfig>;
    const max = c.maxNotesPerParticipant ?? 3;
    let used = 0;
    if (participantId) {
      const [r] = await getDb()
        .select({ used: sql<number>`count(*)::int` })
        .from(sharedNotes)
        .where(and(eq(sharedNotes.interactionId, row.id), eq(sharedNotes.participantId, participantId)));
      used = r.used;
    }
    return {
      id: row.id,
      type: "sharedNotes",
      title: row.title,
      state: "live",
      maxNotes: max,
      remaining: Math.max(0, max - used),
      moderation: c.moderation ?? "open",
      showAuthorNames: c.showAuthorNames ?? false,
    };
  }
  if (row.type === "openText") {
    const max = (row.config as Partial<OpenTextConfig>).maxResponsesPerParticipant ?? 1;
    let used = 0;
    if (participantId) {
      const [r] = await getDb()
        .select({ used: sql<number>`count(*)::int` })
        .from(openTextResponses)
        .where(and(eq(openTextResponses.interactionId, row.id), eq(openTextResponses.participantId, participantId)));
      used = r.used;
    }
    return { id: row.id, type: "openText", title: row.title, state: "live", maxResponses: max, remaining: Math.max(0, max - used) };
  }
  if (row.type === "rating") {
    let mine: number | null = null;
    if (participantId) {
      const [r] = await getDb()
        .select({ value: ratingResponses.value })
        .from(ratingResponses)
        .where(and(eq(ratingResponses.interactionId, row.id), eq(ratingResponses.participantId, participantId)));
      mine = r?.value ?? null;
    }
    const scale = (row.config as Partial<RatingConfig>).scale === "numeric10" ? "numeric10" : "stars5";
    return { id: row.id, type: "rating", title: row.title, state: "live", scale, mine };
  }
  if (row.type !== "poll") return null;
  const config = pollConfig(row.config as Partial<PollConfig>);
  return {
    id: row.id,
    type: "poll",
    title: row.title,
    state: "live",
    options: config.options,
    multiSelect: config.multiSelect,
    showResultsToParticipants: config.showResultsToParticipants,
  };
}
