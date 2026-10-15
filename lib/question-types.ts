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
