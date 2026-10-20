import { serverT } from "@/lib/i18n/server";
import { denyIfPasswordChangeRequired, getSessionUser } from "@/lib/auth/require-admin";
import { isSecureRequest } from "@/lib/auth/session";
import { workspaceSetCookie } from "@/lib/auth/workspace";
import { isUuid } from "@/lib/events";

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
