import { postUpvote } from "@/lib/question-routes";

/** Toggles the caller's upvote: the first call adds it, the next removes it. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return postUpvote(request, (await params).id);
}
