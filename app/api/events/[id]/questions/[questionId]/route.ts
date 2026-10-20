import { serverT } from "@/lib/i18n/server";
import { authorizeModeration } from "@/lib/auth/require-moderation";
import { interactionOfQuestion, patchQuestion, removeQuestion } from "@/lib/question-routes";

type Context = { params: Promise<{ id: string; questionId: string }> };

/** The question's own Q&A: a moderator acts on a question wherever it sits, not only in the live Q&A. */
async function locate(
  request: Request,
  { params }: Context,
): Promise<{ response: Response } | { eventId: string; interactionId: string; questionId: string }> {
  const { id, questionId } = await params;
  const denied = await authorizeModeration(request, id);
  if (denied) return { response: denied };
  const interactionId = await interactionOfQuestion(id, questionId);
  if (!interactionId) {
    return { response: Response.json({ error: serverT(request, "api.questionNotFound") }, { status: 404 }) };
  }
  return { eventId: id, interactionId, questionId };
}

/** Host or moderator: approve/reject a pending question, or pin / mark answered an approved one. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const found = await locate(request, context);
  if ("response" in found) return found.response;
  return patchQuestion(request, found.eventId, found.interactionId, found.questionId);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const found = await locate(request, context);
  if ("response" in found) return found.response;
  return removeQuestion(request, found.eventId, found.interactionId, found.questionId);
}
