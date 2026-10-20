import { getDb } from "@/lib/db";
import { requireOperator } from "@/lib/operator";
import { reactivateWorkspace } from "@/lib/ops-actions";
import { recordOperatorAudit } from "@/lib/ops-audit";
import { opsErrorResponse, opsNotFound, validId } from "@/lib/ops-http";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireOperator(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!validId(id)) return opsNotFound(request);

  const result = await reactivateWorkspace(getDb(), id);
  if (!result.ok) return opsErrorResponse(request, result.error);

  await recordOperatorAudit(request, auth.user, { workspaceId: id, verb: "workspace_reactivated", targetType: "workspace", targetId: id });
  return Response.json({ ok: true });
}
