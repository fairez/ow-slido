import { requireMember } from "@/lib/auth/require-admin";
import { auditContext, recordAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { apiMessage, serverT } from "@/lib/i18n/server";
import { resetMemberPassword } from "@/lib/members";

type Context = { params: Promise<{ userId: string }> };

/** The temporary password is in this response only; the member must change it at next login. No email is sent. */
export async function POST(request: Request, { params }: Context) {
  const auth = await requireMember(request, "members.manage");
  if (!auth.ok) return auth.response;
  const userId = (await params).userId;
  if (!isUuid(userId)) return Response.json({ error: serverT(request, "api.memberNotFound") }, { status: 404 });

  const result = await resetMemberPassword(getDb(), auth.workspaceId, { userId: auth.user.id, role: auth.role }, userId);
  if (!result.ok) return Response.json({ error: apiMessage(request, result), reason: result.reason }, { status: result.status });
  await recordAudit(undefined, {
    ...auditContext(request, auth.user),
    workspaceId: auth.workspaceId,
    action: "member.password_reset",
    targetType: "user",
    targetId: userId,
  });
  return Response.json({ temporaryPassword: result.temporaryPassword }, { headers: { "cache-control": "no-store" } });
}
