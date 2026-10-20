import { serverT } from "@/lib/i18n/server";
import { requireAdmin } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { createModeratorToken, regenerateModeratorToken, revokeModeratorToken } from "@/lib/moderator-token";
import { findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string }> };

const linkFor = (eventId: string, token: string) => `/moderate/${eventId}?t=${encodeURIComponent(token)}`;

async function ownedEvent(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const event = isUuid(id) ? await findOwnedEvent(id, auth.user.id) : null;
  return event ?? Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });
}

/** Host-only: the current moderator link (path), or null if none is active. */
export async function GET(request: Request, context: Context) {
  const event = await ownedEvent(request, context);
  if (event instanceof Response) return event;
  const link = event.moderatorNonce ? linkFor(event.id, createModeratorToken(event.id, event.moderatorNonce)) : null;
  return Response.json({ link });
}

/** Host-only: generate a new link; any previous one stops working. */
export async function POST(request: Request, context: Context) {
  const event = await ownedEvent(request, context);
  if (event instanceof Response) return event;
  return Response.json({ link: linkFor(event.id, await regenerateModeratorToken(event.id)) });
}

/** Host-only: revoke the link. */
export async function DELETE(request: Request, context: Context) {
  const event = await ownedEvent(request, context);
  if (event instanceof Response) return event;
  await revokeModeratorToken(event.id);
  return new Response(null, { status: 204 });
}
