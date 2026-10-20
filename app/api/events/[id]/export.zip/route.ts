import { serverT } from "@/lib/i18n/server";
import { requireMember } from "@/lib/auth/require-admin";
import { buildEventZip } from "@/lib/export";
import { PlanLimitError, assertReportFormat, planLimitResponse } from "@/lib/limits";
import { auditContext, recordAudit } from "@/lib/audit";
import { workspaceRateLimited } from "@/lib/workspace-rate-limit";
import { findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await requireMember(request, "export");
  if (!auth.ok) return auth.response;

  const event = await findOwnedEvent((await params).id, auth.workspaceId);
  if (!event) return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });

  try {
    await assertReportFormat(auth.workspaceId, "csv");
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }

  const limited = await workspaceRateLimited(request, auth.workspaceId, "zip");
  if (limited) return limited;

  await recordAudit(undefined, {
    ...auditContext(request, auth.user),
    workspaceId: auth.workspaceId,
    action: "event.exported",
    targetType: "event",
    targetId: event.id,
    metadata: { format: "zip", eventName: event.name },
  });

  const filename = `${event.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event"}-results.zip`;
  return new Response(new Uint8Array(await buildEventZip(event.id)), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
