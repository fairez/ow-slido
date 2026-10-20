import { serverT } from "@/lib/i18n/server";
import { requireAdmin } from "@/lib/auth/require-admin";
import { findOwnedEvent } from "@/lib/polls";
import { getPresenterState } from "@/lib/presenter";

/** Live poll plus counts for the owner's presenter screen (initial load and reconnect resync). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const event = await findOwnedEvent((await params).id, auth.user.id);
  if (!event) return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });
  const closed = new URL(request.url).searchParams.get("closed") ?? undefined;
  return Response.json({ interaction: await getPresenterState(event.id, closed) });
}
