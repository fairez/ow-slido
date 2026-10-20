/** Db-free question types and limits, safe to import from client components. */
export const QUESTION_MAX_LENGTH = 300;
export const AUTHOR_NAME_MAX_LENGTH = 40;

/** The shape participants may see; never includes participant ids or status. */
export type PublicQuestion = {
  id: string;
  text: string;
  authorName: string | null;
  answered: boolean;
  pinned: boolean;
  createdAt: string;
  /** Number of upvotes. */
  upvotes: number;
  /** Whether the requesting participant has upvoted; false for the host. */
  upvoted: boolean;
};

/** Host-side view: adds the moderation status; rejected questions are not listed. */
export type HostQuestion = PublicQuestion & { status: "pending" | "approved" };

/** One Q&A as a participant sees it: its prompt, state and approved questions. */
export type ParticipantQa = {
  id: string;
  title: string;
  prompt: string;
  state: "live" | "paused" | "closed";
  questions: PublicQuestion[];
};

/**
 * What the participant Q&A tab shows. `current` is the live Q&A, else the latest paused or closed one (read-only);
 * `earlier` holds the other closed ones, newest first.
 */
export type ParticipantQaView = {
  current: ParticipantQa | null;
  earlier: ParticipantQa[];
  /** Set when the event's Q&As are all drafts: the host has not opened one, so there is nothing to ask yet. */
  notOpen?: true;
};
