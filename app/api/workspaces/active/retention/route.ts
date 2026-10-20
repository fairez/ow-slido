import { workspaces } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireMember } from "@/lib/auth/require-admin";
import { auditContext, recordAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";
import { parseRetentionDays, setRetentionDays } from "@/lib/retention";

export async function GET(request: Request) {
  const auth = await requireMember(request, "members.manage");
  if (!auth.ok) return auth.response;
  const [row] = await getDb()
    .select({ retentionDays: workspaces.retentionDays })
    .from(workspaces)
    .where(eq(workspaces.id, auth.workspaceId));
  return Response.json({ retentionDays: row?.retentionDays ?? null });
}

/** Sets how many days after an event ends its data is deleted: 30, 90, 365, or null to keep everything. */
export async function PATCH(request: Request) {
  const auth = await requireMember(request, "members.manage");
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => null)) as { retentionDays?: unknown } | null;
  const parsed = body && "retentionDays" in body ? parseRetentionDays(body.retentionDays) : { ok: false as const };
  if (!parsed.ok) return Response.json({ error: serverT(request, "api.invalidBody") }, { status: 400 });

  const before = await setRetentionDays(getDb(), auth.workspaceId, parsed.value);
  // The membership guarantees the workspace exists; this only narrows the type.
  if (!before) return Response.json({ error: serverT(request, "api.invalidBody") }, { status: 400 });
  if (before.from !== parsed.value) {
    await recordAudit(undefined, {
      ...auditContext(request, auth.user),
      workspaceId: auth.workspaceId,
      action: "workspace.settings_changed",
      targetType: "workspace",
      targetId: auth.workspaceId,
      metadata: { setting: "retention_days", from: before.from, to: parsed.value },
    });
  }
  return Response.json({ retentionDays: parsed.value });
}
