import { requireMember } from "@/lib/auth/require-admin";
import { listAuditEntries, parseAuditFilters } from "@/lib/audit-query";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";
import { PlanLimitError, assertAuditLog, planLimitResponse } from "@/lib/limits";

export async function GET(request: Request) {
  const auth = await requireMember(request, "audit.view");
  if (!auth.ok) return auth.response;
  try {
    await assertAuditLog(auth.workspaceId);
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }
  const filters = parseAuditFilters(new URL(request.url).searchParams);
  if (!filters.ok) {
    return Response.json({ error: serverT(request, "api.auditBadFilter"), field: filters.error }, { status: 400 });
  }
  const result = await listAuditEntries(getDb(), auth.workspaceId, filters.value);
  return Response.json({ ...result, entries: result.entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })) });
}
