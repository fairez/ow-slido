import { serverT, apiMessage } from "@/lib/i18n/server";
import { authorizeModeration } from "@/lib/auth/require-moderation";
import { isUuid } from "@/lib/events";
import { deleteNoteAsHost, moderateNote } from "@/lib/moderation";

type Context = { params: Promise<{ id: string; noteId: string }> };

async function authorize(request: Request, { params }: Context): Promise<Response | { eventId: string; noteId: string }> {
  const { id, noteId } = await params;
  const denied = await authorizeModeration(request, id);
  if (denied) return denied;
  if (!isUuid(id) || !isUuid(noteId)) return Response.json({ error: serverT(request, "api.noteNotFound") }, { status: 404 });
  return { eventId: id, noteId };
}

/** Host or moderator: approve/reject a pending note, or pin an approved one. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const found = await authorize(request, context);
  if (found instanceof Response) return found;
  const body = await request.json().catch(() => null);
  const change = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const result = await moderateNote(found.eventId, found.noteId, change);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ ok: true, note: result.note });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const found = await authorize(request, context);
  if (found instanceof Response) return found;
  if (!(await deleteNoteAsHost(found.eventId, found.noteId))) {
    return Response.json({ error: serverT(request, "api.noteNotFound") }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
