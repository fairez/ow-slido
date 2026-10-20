import { eq } from "drizzle-orm";
import { workspaces } from "@/db/schema";
import { requireMember } from "@/lib/auth/require-admin";
import { isTwoFactorConfigured } from "@/lib/auth/two-factor";
import { auditContext, recordAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";
import { PlanLimitError, assertCanEnforceTwoFactor, planLimitResponse } from "@/lib/limits";

/** Switches the 2FA requirement for the active workspace. Turning it on needs the plan; turning it off never does. */
export async function PATCH(request: Request) {
  const auth = await requireMember(request, "members.manage");
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => null)) as { require2fa?: unknown } | null;
  if (typeof body?.require2fa !== "boolean") {
    return Response.json({ error: serverT(request, "api.invalidBody") }, { status: 400 });
  }

  if (body.require2fa) {
    try {
      await assertCanEnforceTwoFactor(auth.workspaceId);
    } catch (error) {
      if (error instanceof PlanLimitError) return planLimitResponse(request, error);
      throw error;
    }
  }
  // Members can only enrol with the server key, so a requirement without it would lock everyone out.
  if (body.require2fa && !isTwoFactorConfigured()) {
    return Response.json({ error: serverT(request, "api.twoFactorUnavailable") }, { status: 503 });
  }
  const [before] = await getDb().select({ require2fa: workspaces.require2fa }).from(workspaces).where(eq(workspaces.id, auth.workspaceId));
  await getDb().update(workspaces).set({ require2fa: body.require2fa }).where(eq(workspaces.id, auth.workspaceId));
  if (before?.require2fa !== body.require2fa) {
    await recordAudit(undefined, {
      ...auditContext(request, auth.user),
      workspaceId: auth.workspaceId,
      action: "workspace.settings_changed",
      targetType: "workspace",
      targetId: auth.workspaceId,
      metadata: { setting: "require_2fa", from: before?.require2fa ?? false, to: body.require2fa },
    });
  }
  return Response.json({ require2fa: body.require2fa });
}
