import { patchQuestion, qaOr404, removeQuestion } from "@/lib/question-routes";

type Context = { params: Promise<{ id: string; questionId: string }> };

/** Host or moderator: approve/reject a pending question, or pin / mark answered an approved one. */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const { id, questionId } = await params;
  const qa = await qaOr404(request, id);
  if ("response" in qa) return qa.response;
  return patchQuestion(request, qa.eventId, qa.id, questionId);
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const { id, questionId } = await params;
  const qa = await qaOr404(request, id);
  if ("response" in qa) return qa.response;
  return removeQuestion(request, qa.eventId, qa.id, questionId);
}
