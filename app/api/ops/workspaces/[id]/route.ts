import { getDb } from "@/lib/db";
import { requireOperator } from "@/lib/operator";
import { getOpsWorkspaceDetail } from "@/lib/ops-workspaces";
import { opsNotFound, validId } from "@/lib/ops-http";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await requireOperator(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const detail = validId(id) ? await getOpsWorkspaceDetail(getDb(), id) : null;
  if (!detail) return opsNotFound(request);
  return Response.json(detail);
}
