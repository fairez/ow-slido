import { and, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { RatingConfig } from "@/lib/interaction-config";
import { interactionModule } from "@/lib/interaction-modules";
import type { PollOption } from "@/lib/polls";

/** What a participant may see of the live interaction; host-only settings are left out. */
export type LivePoll = {
  id: string;
  type: "poll";
  title: string;
  state: "live" | "paused" | "closed";
  options: PollOption[];
  multiSelect: boolean;
  /** Whether the participant may see vote counts; the client must not show them otherwise. */
  showResultsToParticipants: boolean;
};

export type LiveWordcloud = {
  id: string;
  type: "wordcloud";
  title: string;
  state: "live" | "paused" | "closed";
  maxEntries: number;
  /** Entries this participant may still submit; equals maxEntries when the participant is unknown. */
  remaining: number;
};

export type LiveNotes = {
  id: string;
  type: "sharedNotes";
  title: string;
  state: "live" | "paused" | "closed";
  maxNotes: number;
  /** Notes this participant may still write; equals maxNotes when the participant is unknown. */
  remaining: number;
  moderation: "open" | "moderated";
  showAuthorNames: boolean;
  /** True when AI is configured, so the screen discloses that notes may be summarised. */
  aiDisclosure: boolean;
};

export type LiveOpenText = {
  id: string;
  type: "openText";
  title: string;
  state: "live" | "paused" | "closed";
  maxResponses: number;
  /** Responses this participant may still send; equals maxResponses when the participant is unknown. */
  remaining: number;
};

export type LiveRating = {
  id: string;
  type: "rating";
  title: string;
  state: "live" | "paused" | "closed";
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
  return row ? interactionModule(row.type).live(row, participantId) : null;
}
