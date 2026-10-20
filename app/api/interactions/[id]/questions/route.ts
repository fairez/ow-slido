import { getQuestions, postQuestion, qaOr404 } from "@/lib/question-routes";

type Context = { params: Promise<{ id: string }> };

/** Participant asks a question in this Q&A. */
export async function POST(request: Request, { params }: Context) {
  const qa = await qaOr404(request, (await params).id);
  if ("response" in qa) return qa.response;
  return postQuestion(request, qa.eventId, qa.id);
}

/** Approved questions of this Q&A for the event's participants and its host. */
export async function GET(request: Request, { params }: Context) {
  const qa = await qaOr404(request, (await params).id);
  if ("response" in qa) return qa.response;
  return getQuestions(request, qa.eventId, qa.id);
}
