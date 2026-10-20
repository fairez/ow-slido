import { getQuestionQueue, qaOr404 } from "@/lib/question-routes";

/** Host or moderator: pending and approved questions of this Q&A. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const qa = await qaOr404(request, (await params).id);
  if ("response" in qa) return qa.response;
  return getQuestionQueue(request, qa.id, qa.eventId);
}
