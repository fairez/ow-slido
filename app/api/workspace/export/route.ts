import { requireMember } from "@/lib/auth/require-admin";
import { auditContext, recordAudit } from "@/lib/audit";
import { serverT } from "@/lib/i18n/server";
import { requestWorkspaceExport, scheduleWorkspaceExport } from "@/lib/workspace-export";

/** Starts a whole-workspace export for the owner. The ZIP is built after the response; poll the status route. */
export async function POST(request: Request) {
  const auth = await requireMember(request, "workspace.export");
  if (!auth.ok) return auth.response;

  const result = await requestWorkspaceExport({ workspaceId: auth.workspaceId, userId: auth.user.id });
  if (!result.ok) {
    return Response.json(
      { error: serverT(request, "api.exportRunning"), reason: "export_running", id: result.exportId },
      { status: 409 },
    );
  }

  await recordAudit(undefined, {
    ...auditContext(request, auth.user),
    workspaceId: auth.workspaceId,
    action: "workspace.export_requested",
    targetType: "workspace_export",
    targetId: result.exportId,
  });
  scheduleWorkspaceExport(result.exportId);
  return Response.json({ id: result.exportId, status: "queued" }, { status: 202 });
}
