import { serverT, apiMessage } from "@/lib/i18n/server";
import { requireMember } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { deleteResponseAsHost, updateResponseAsHost } from "@/lib/open-text";

type Context = { params: Promise<{ id: string }> };

/** Owning host only: highlight or hide a response. */
export async function PATCH(request: Request, { params }: Context) {
  const auth = await requireMember(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: serverT(request, "api.responseNotFound") }, { status: 404 });
  const body = await request.json().catch(() => null);
  const change = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const result = await updateResponseAsHost(id, auth.workspaceId, change);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ response: result.response });
}

export async function DELETE(request: Request, { params }: Context) {
  const auth = await requireMember(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!isUuid(id) || !(await deleteResponseAsHost(id, auth.workspaceId))) {
    return Response.json({ error: serverT(request, "api.responseNotFound") }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
