import { getDb } from "@/lib/db";
import { requireOperator } from "@/lib/operator";
import { clearPlanOverride, setPlanOverride } from "@/lib/ops-actions";
import { recordOperatorAudit } from "@/lib/ops-audit";
import { opsErrorResponse, opsNotFound, validId } from "@/lib/ops-http";

type Context = { params: Promise<{ id: string }> };

/** Body: `{plan, until, reason}`. The end date and the reason are both required. */
export async function PUT(request: Request, { params }: Context) {
  const auth = await requireOperator(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!validId(id)) return opsNotFound(request);

  const body = (await request.json().catch(() => null)) as { plan?: unknown; until?: unknown; reason?: unknown } | null;
  const result = await setPlanOverride(getDb(), id, { plan: body?.plan, until: body?.until, reason: body?.reason });
  if (!result.ok) return opsErrorResponse(request, result.error);

  await recordOperatorAudit(request, auth.user, {
    workspaceId: id,
    verb: "plan_override_set",
    targetType: "workspace",
    targetId: id,
    metadata: { plan: result.plan, until: result.until.toISOString(), reason: result.reason },
  });
  return Response.json({ ok: true, plan: result.plan, until: result.until.toISOString() });
}

export async function DELETE(request: Request, { params }: Context) {
  const auth = await requireOperator(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!validId(id)) return opsNotFound(request);

  const result = await clearPlanOverride(getDb(), id);
  if (!result.ok) return opsErrorResponse(request, result.error);

  await recordOperatorAudit(request, auth.user, { workspaceId: id, verb: "plan_override_cleared", targetType: "workspace", targetId: id });
  return Response.json({ ok: true });
}
