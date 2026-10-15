import { requireAdmin } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { deleteQuestion, moderateQuestion } from "@/lib/moderation";
import { findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string; questionId: string }> };

async function authorize(request: Request, { params }: Context): Promise<Response | { eventId: string; questionId: string }> {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id, questionId } = await params;
  if (!isUuid(id) || !(await findOwnedEvent(id, auth.user.id))) {
    return Response.json({ error: "Event not found" }, { status: 404 });
  }
  if (!isUuid(questionId)) return Response.json({ error: "Question not found" }, { status: 404 });
  return { eventId: id, questionId };
}

/** Host-only: approve/reject a pending question, or pin / mark answered an approved one. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const found = await authorize(request, context);
  if (found instanceof Response) return found;
  const body = await request.json().catch(() => null);
  const change = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const result = await moderateQuestion(found.eventId, found.questionId, change);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, question: result.question });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const found = await authorize(request, context);
  if (found instanceof Response) return found;
  if (!(await deleteQuestion(found.eventId, found.questionId))) {
    return Response.json({ error: "Question not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
