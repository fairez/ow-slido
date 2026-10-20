import { getDb } from "@/lib/db";
import { requireOperator } from "@/lib/operator";
import { resetMemberTwoFactor } from "@/lib/ops-actions";
import { recordOperatorAudit } from "@/lib/ops-audit";
import { opsErrorResponse, opsNotFound, validId } from "@/lib/ops-http";

type Context = { params: Promise<{ id: string; userId: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireOperator(request);
  if (!auth.ok) return auth.response;
  const { id, userId } = await params;
  if (!validId(id) || !validId(userId)) return opsNotFound(request);

  const result = await resetMemberTwoFactor(getDb(), id, userId);
  if (!result.ok) return opsErrorResponse(request, result.error);

  await recordOperatorAudit(request, auth.user, {
    workspaceId: id,
    verb: "two_factor_reset",
    targetType: "user",
    targetId: userId,
    metadata: { hadTwoFactor: result.hadTwoFactor },
  });
  return Response.json({ ok: true, hadTwoFactor: result.hadTwoFactor });
}
