import { eq } from "drizzle-orm";
import { workspaces } from "@/db/schema";
import { requireMember } from "@/lib/auth/require-admin";
import { auditContext, recordAudit } from "@/lib/audit";
import { checkAccentContrast, contrastFailureMessage, parseAccent } from "@/lib/brand-accent";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";
import { PlanLimitError, assertBranding, planLimitResponse } from "@/lib/limits";

export async function GET(request: Request) {
  const auth = await requireMember(request, "branding.manage");
  if (!auth.ok) return auth.response;
  const [row] = await getDb().select({ accent: workspaces.brandAccent }).from(workspaces).where(eq(workspaces.id, auth.workspaceId));
  return Response.json({ accent: row?.accent ?? null });
}

/**
 * Sets the workspace accent colour (`#rgb` or `#rrggbb`), or removes it with null. Setting needs the plan and must
 * pass AA contrast; removing never needs the plan, so a downgraded workspace can still go back to the default.
 */
export async function PATCH(request: Request) {
  const auth = await requireMember(request, "branding.manage");
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => null)) as { accent?: unknown } | null;
  if (!body || !("accent" in body) || (body.accent !== null && typeof body.accent !== "string")) {
    return Response.json({ error: serverT(request, "api.invalidBody") }, { status: 400 });
  }

  let accent: string | null = null;
  if (body.accent !== null) {
    const hex = parseAccent(body.accent);
    if (!hex) return Response.json({ error: serverT(request, "api.brandingInvalidColour"), reason: "invalid_colour" }, { status: 400 });
    try {
      await assertBranding(auth.workspaceId);
    } catch (error) {
      if (error instanceof PlanLimitError) return planLimitResponse(request, error);
      throw error;
    }
    const check = checkAccentContrast(hex);
    if (!check.ok) {
      // parseAccent already passed, so the only way to fail here is contrast.
      const failures = check.reason === "contrast" ? check.failures : [];
      return Response.json(
        { error: contrastFailureMessage((key, params) => serverT(request, key, params), hex, failures), reason: "contrast_failed", failures },
        { status: 422 },
      );
    }
    accent = check.hex;
  }

  const [before] = await getDb().select({ accent: workspaces.brandAccent }).from(workspaces).where(eq(workspaces.id, auth.workspaceId));
  await getDb().update(workspaces).set({ brandAccent: accent }).where(eq(workspaces.id, auth.workspaceId));
  if ((before?.accent ?? null) !== accent) {
    await recordAudit(undefined, {
      ...auditContext(request, auth.user),
      workspaceId: auth.workspaceId,
      action: "workspace.settings_changed",
      targetType: "workspace",
      targetId: auth.workspaceId,
      metadata: { setting: "brand_accent", from: before?.accent ?? null, to: accent },
    });
  }
  return Response.json({ accent });
}
