import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";
import { requireOperator } from "@/lib/operator";
import { listOpsWorkspaces, parseOpsFilters } from "@/lib/ops-workspaces";

export async function GET(request: Request) {
  const auth = await requireOperator(request);
  if (!auth.ok) return auth.response;
  const filters = parseOpsFilters(new URL(request.url).searchParams);
  if (!filters.ok) {
    return Response.json({ error: serverT(request, "ops.badFilter"), field: filters.error }, { status: 400 });
  }
  const result = await listOpsWorkspaces(getDb(), filters.value);
  return Response.json({ ...result, workspaces: result.workspaces.map((w) => ({ ...w, createdAt: w.createdAt.toISOString(), suspendedAt: w.suspendedAt?.toISOString() ?? null })) });
}
