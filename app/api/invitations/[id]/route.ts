import { requireMember } from "@/lib/auth/require-admin";
import { auditContext, recordAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { apiMessage, serverT } from "@/lib/i18n/server";
import { revokeInvitation } from "@/lib/invitations";
import { reconcileSeats } from "@/lib/seats";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Context) {
  const auth = await requireMember(request, "members.manage");
  if (!auth.ok) return auth.response;

  const id = (await params).id;
  if (!isUuid(id)) return Response.json({ error: serverT(request, "api.inviteNotFound") }, { status: 404 });
  const result = await revokeInvitation(getDb(), auth.workspaceId, id);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  await recordAudit(undefined, {
    ...auditContext(request, auth.user),
    workspaceId: auth.workspaceId,
    action: "invitation.revoked",
    targetType: "invitation",
    targetId: id,
  });
  // The freed seat may bring back a member the plan had suspended.
  await reconcileSeats(auth.workspaceId);
  return Response.json({ ok: true });
}
