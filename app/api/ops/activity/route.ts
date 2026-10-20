import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";
import { requireOperator } from "@/lib/operator";
import { listOperatorActivity } from "@/lib/ops-audit";
import { parseOpsFilters } from "@/lib/ops-workspaces";

export async function GET(request: Request) {
  const auth = await requireOperator(request);
  if (!auth.ok) return auth.response;
  const filters = parseOpsFilters(new URL(request.url).searchParams);
  if (!filters.ok) return Response.json({ error: serverT(request, "ops.badFilter"), field: filters.error }, { status: 400 });
  const page = await listOperatorActivity(getDb(), filters.value.page);
  return Response.json({ ...page, entries: page.entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })) });
}
