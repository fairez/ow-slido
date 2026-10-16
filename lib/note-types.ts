/** Db-free shared-notes types for client components. */
export type HostNote = {
  id: string;
  interactionId: string;
  /** Title of the shared-notes interaction the note belongs to. */
  interactionTitle: string;
  text: string;
  authorName: string | null;
  status: "pending" | "approved";
  pinned: boolean;
  createdAt: string;
  upvotes: number;
};
