import { postUpvote, qaOr404 } from "@/lib/question-routes";

/** Toggles the caller's upvote on a question of this Q&A. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; questionId: string }> }) {
  const { id, questionId } = await params;
  const qa = await qaOr404(request, id);
  if ("response" in qa) return qa.response;
  return postUpvote(request, questionId, qa.id);
}
