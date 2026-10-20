import { requireMember } from "@/lib/auth/require-admin";
import { auditContext, recordAudit } from "@/lib/audit";
import { serverT } from "@/lib/i18n/server";
import { getWorkspaceExport, readWorkspaceExportFile, verifyDownloadLink } from "@/lib/workspace-export";

type Context = { params: Promise<{ id: string }> };

/** The ZIP. Needs the owner's session and the signed link from the status route. */
export async function GET(request: Request, { params }: Context) {
  const auth = await requireMember(request, "workspace.export");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const row = await getWorkspaceExport(id, auth.workspaceId);
  if (!row) return Response.json({ error: serverT(request, "api.exportNotFound") }, { status: 404 });

  const url = new URL(request.url);
  if (!verifyDownloadLink(id, url.searchParams.get("expires"), url.searchParams.get("sig"))) {
    return Response.json({ error: serverT(request, "api.exportLinkInvalid") }, { status: 403 });
  }
  if (row.status === "expired") return Response.json({ error: serverT(request, "api.exportExpired") }, { status: 410 });
  if (row.status !== "done") return Response.json({ error: serverT(request, "api.exportNotReady") }, { status: 409 });

  const zip = await readWorkspaceExportFile(id, auth.workspaceId);
  if (!zip) return Response.json({ error: serverT(request, "api.exportExpired") }, { status: 410 });

  await recordAudit(undefined, {
    ...auditContext(request, auth.user),
    workspaceId: auth.workspaceId,
    action: "workspace.export_downloaded",
    targetType: "workspace_export",
    targetId: id,
  });
  return new Response(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="workspace-export-${new Date().toISOString().slice(0, 10)}.zip"`,
      "cache-control": "no-store",
    },
  });
}
