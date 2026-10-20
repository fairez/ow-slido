import { and, eq, inArray } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { INTERACTION_MODULES, interactionModule } from "@/lib/interaction-modules";
import type { PublicResponse } from "@/lib/open-text";
import type { QuizResults } from "@/lib/quiz";
import type { RankingResults } from "@/lib/ranking";
import type { RatingResults } from "@/lib/rating";
import type { PublicNote } from "@/lib/shared-notes";
import type { WordCount } from "@/lib/wordclouds";
import type { PollOption } from "@/lib/polls";

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

export type PresenterRanking = {
  type: "ranking";
  id: string;
  title: string;
  state: "live" | "paused" | "closed";
  results: RankingResults;
};

/**
 * A quiz question on the projector. While it is live only the answer count is known; `results` (per-option
 * counts and which options are correct) arrives once the question is closed, so the screen never gives the answer away.
 */
export type PresenterQuiz = {
  type: "quiz";
  id: string;
  title: string;
  state: "live" | "paused" | "closed";
  prompt: string;
  options: { id: string; text: string }[];
  timeLimitSeconds: number;
  /** Database clock, epoch ms; null when the question has not started a window. */
  deadlineAt: number | null;
  serverNow: number;
  total: number;
  results: QuizResults | null;
};

export type PresenterState =
  | PresenterPoll
  | PresenterWordcloud
  | PresenterNotes
  | PresenterOpenText
  | PresenterRating
  | PresenterRanking
  | PresenterQuiz;

/** The live interaction, or the shared-notes, open-text or rating interaction named by `closedNotesId` once it has closed. */
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
          inArray(
            interactions.type,
            INTERACTION_MODULES.filter((m) => m.presentWhenClosed).map((m) => m.type),
          ),
          eq(interactions.state, "closed"),
        ),
      );
  }
  return row ? interactionModule(row.type).presenter(row) : null;
}
