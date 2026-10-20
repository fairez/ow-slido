import { eq } from "drizzle-orm";
import { workspaces } from "@/db/schema";
import { serverT } from "@/lib/i18n/server";
import { denyIfPasswordChangeRequired, getSessionUser, requireMember } from "@/lib/auth/require-admin";
import { isSecureRequest } from "@/lib/auth/session";
import { workspaceSetCookie } from "@/lib/auth/workspace";
import { billingErrorResponse } from "@/lib/billing/http";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { deleteWorkspace } from "@/lib/workspace-deletion";

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
  const blocked = denyIfPasswordChangeRequired(request, user);
  if (blocked) return blocked;

  const body = (await request.json().catch(() => null)) as { workspaceId?: unknown } | null;
  const workspaceId = body?.workspaceId;
  const allowed =
    typeof workspaceId === "string" &&
    isUuid(workspaceId) &&
    user.memberships.some((m) => m.workspaceId === workspaceId && m.status === "active");
  if (!allowed) return Response.json({ error: serverT(request, "api.forbidden") }, { status: 403 });

  return Response.json(
    { workspaceId },
    { headers: { "Set-Cookie": workspaceSetCookie(workspaceId, isSecureRequest(request)) } },
  );
}

/**
 * Owner only. Deletes the active workspace and everything in it once `name` matches the workspace name. The
 * subscription is cancelled first; if the provider cannot do that, nothing is deleted.
 */
export async function DELETE(request: Request) {
  const auth = await requireMember(request, "workspace.delete");
  if (!auth.ok) return auth.response;

  const db = getDb();
  const [workspace] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, auth.workspaceId));
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  if (!workspace || typeof body?.name !== "string" || body.name.trim() !== workspace.name) {
    return Response.json({ error: serverT(request, "api.workspaceNameMismatch"), reason: "name_mismatch" }, { status: 400 });
  }

  let result;
  try {
    result = await deleteWorkspace(db, auth.workspaceId);
  } catch (error) {
    const response = billingErrorResponse(request, error);
    if (response) return response;
    throw error;
  }
  if (!result.ok) return Response.json({ error: serverT(request, result.error) }, { status: result.status });

  // Its audit rows went with it; the content-free `deleted_workspaces` row is all that is kept (no email, no name).
  return Response.json({ ok: true });
}
