import { requireMember } from "@/lib/auth/require-admin";
import { serverT } from "@/lib/i18n/server";
import { getWorkspaceExport, signDownloadLink } from "@/lib/workspace-export";

type Context = { params: Promise<{ id: string }> };

/** Status of one export. While it is done and its file is kept, `downloadUrl` is a link that works for a few minutes. */
export async function GET(request: Request, { params }: Context) {
  const auth = await requireMember(request, "workspace.export");
  if (!auth.ok) return auth.response;

  const row = await getWorkspaceExport((await params).id, auth.workspaceId);
  if (!row) return Response.json({ error: serverT(request, "api.exportNotFound") }, { status: 404 });

  return Response.json({
    id: row.id,
    status: row.status,
    error: row.error,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    expiresAt: row.expiresAt,
    downloadUrl: row.status === "done" ? signDownloadLink(row.id) : null,
  });
}
