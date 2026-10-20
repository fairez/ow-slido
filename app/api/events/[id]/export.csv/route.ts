import { serverT } from "@/lib/i18n/server";
import { requireMember } from "@/lib/auth/require-admin";
import { buildEventCsv } from "@/lib/export";
import { findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await requireMember(request);
  if (!auth.ok) return auth.response;

  const event = await findOwnedEvent((await params).id, auth.workspaceId);
  if (!event) return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });

  const filename = `${event.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event"}-results.csv`;
  return new Response(await buildEventCsv(event.id), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
