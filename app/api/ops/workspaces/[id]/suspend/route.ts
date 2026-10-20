import { getDb } from "@/lib/db";
import { requireOperator } from "@/lib/operator";
import { cleanReason, suspendWorkspace } from "@/lib/ops-actions";
import { recordOperatorAudit } from "@/lib/ops-audit";
import { opsErrorResponse, opsNotFound, validId } from "@/lib/ops-http";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireOperator(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!validId(id)) return opsNotFound(request);

  const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
  const result = await suspendWorkspace(getDb(), id, body?.reason);
  if (!result.ok) return opsErrorResponse(request, result.error);

  await recordOperatorAudit(request, auth.user, {
    workspaceId: id,
    verb: "workspace_suspended",
    targetType: "workspace",
    targetId: id,
    metadata: { reason: cleanReason(body?.reason) },
  });
  return Response.json({ ok: true });
}
