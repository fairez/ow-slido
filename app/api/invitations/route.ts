import { denyUnlessVerified, requireMember } from "@/lib/auth/require-admin";
import { auditContext, recordAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { apiMessage, serverT } from "@/lib/i18n/server";
import { createInvitation, listInvitations, parseInviteInput, sendInvitationEmail } from "@/lib/invitations";
import { workspaceRateLimited } from "@/lib/workspace-rate-limit";
import { PlanLimitError, planLimitResponse } from "@/lib/limits";
import { assertSeatAvailable } from "@/lib/seats";

export async function GET(request: Request) {
  const auth = await requireMember(request, "members.manage");
  if (!auth.ok) return auth.response;
  return Response.json({ invitations: await listInvitations(getDb(), auth.workspaceId) });
}

/** The link is in this response and in the email; it is not stored in a readable form, so it cannot be fetched again. */
export async function POST(request: Request) {
  const auth = await requireMember(request, "members.manage");
  if (!auth.ok) return auth.response;
  const unverified = denyUnlessVerified(request, auth.user);
  if (unverified) return unverified;

  const parsed = parseInviteInput(await request.json().catch(() => null));
  if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: parsed.status });

  const limited = await workspaceRateLimited(request, auth.workspaceId, "invitation");
  if (limited) return limited;

  try {
    await assertSeatAvailable(auth.workspaceId);
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }

  const db = getDb();
  const created = await createInvitation(db, {
    workspaceId: auth.workspaceId,
    email: parsed.value.email,
    role: parsed.value.role,
    invitedBy: auth.user.id,
  });
  if (!created.ok) return Response.json({ error: apiMessage(request, created) }, { status: created.status });

  await recordAudit(db, {
    ...auditContext(request, auth.user),
    workspaceId: auth.workspaceId,
    action: "invitation.created",
    targetType: "invitation",
    targetId: created.invitation.id,
    metadata: { role: created.invitation.role },
  });

  const link = `${new URL(request.url).origin}/invite?token=${encodeURIComponent(created.token)}`;
  const emailSent = await sendInvitationEmail(
    db,
    { workspaceId: auth.workspaceId, email: created.invitation.email, role: created.invitation.role, link },
    (key, params) => serverT(request, key, params),
  );
  return Response.json({ invitation: created.invitation, link, emailSent }, { status: 201 });
}
