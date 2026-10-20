import { and, eq, ne } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { RankingOption, RatingConfig } from "@/lib/interaction-config";
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

export type LiveRanking = {
  id: string;
  type: "ranking";
  title: string;
  state: "live" | "paused" | "closed";
  prompt: string;
  /** In the host's order; the participant reorders their own copy. */
  options: RankingOption[];
  /** This participant's submitted order (option ids), or null; a ranking cannot be changed. */
  mine: string[] | null;
};

export type LiveQuiz = {
  id: string;
  type: "quiz";
  title: string;
  state: "live" | "paused" | "closed";
  prompt: string;
  /** In the host's order. The correct ones are never sent while the question is live. */
  options: RankingOption[];
  /** More than one option is correct, so the participant picks a set and sends it. */
  multiple: boolean;
  timeLimitSeconds: number;
  /** `deadline_at` and the database clock "now", both epoch ms, so the client can correct its own clock. */
  deadlineAt: number | null;
  serverNow: number;
  /** This participant's selected option ids, or null; an answer cannot be changed. */
  mine: string[] | null;
  /** The display name the leaderboard shows, or null until the participant picks one. */
  nickname: string | null;
  /** True after the first quiz answer of the event; the name no longer changes. */
  nicknameLocked: boolean;
};

export type LiveInteraction = LivePoll | LiveWordcloud | LiveNotes | LiveOpenText | LiveRating | LiveRanking | LiveQuiz;

export async function getLiveInteraction(
  eventId: string,
  participantId?: string,
): Promise<LiveInteraction | null> {
  const [row] = await getDb()
    .select()
    .from(interactions)
    .where(and(eq(interactions.eventId, eventId), eq(interactions.state, "live"), ne(interactions.type, "survey")));
  return row ? interactionModule(row.type).live(row, participantId) : null;
}
