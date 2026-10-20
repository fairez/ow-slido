import { serverT, apiMessage } from "@/lib/i18n/server";
import { authorizeModeration } from "@/lib/auth/require-moderation";
import { isUuid } from "@/lib/events";
import { deleteQuestion, moderateQuestion } from "@/lib/moderation";

type Context = { params: Promise<{ id: string; questionId: string }> };

async function authorize(request: Request, { params }: Context): Promise<Response | { eventId: string; questionId: string }> {
  const { id, questionId } = await params;
  const denied = await authorizeModeration(request, id);
  if (denied) return denied;
  if (!isUuid(questionId)) return Response.json({ error: serverT(request, "api.questionNotFound") }, { status: 404 });
  return { eventId: id, questionId };
}

/** Host or moderator: approve/reject a pending question, or pin / mark answered an approved one. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const found = await authorize(request, context);
  if (found instanceof Response) return found;
  const body = await request.json().catch(() => null);
  const change = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const result = await moderateQuestion(found.eventId, found.questionId, change);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ ok: true, question: result.question });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const found = await authorize(request, context);
  if (found instanceof Response) return found;
  if (!(await deleteQuestion(found.eventId, found.questionId))) {
    return Response.json({ error: serverT(request, "api.questionNotFound") }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
