import { serverT } from "@/lib/i18n/server";
import { requireMember } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { MODERATOR_HEADER, verifyModeratorToken } from "@/lib/moderator-token";
import { findOwnedEvent } from "@/lib/polls";

/**
 * Access to one event's moderation queue: the owning host (session) or a moderator holding a valid,
 * unrevoked token for that event. Only the moderation-queue endpoints may call this.
 */
export async function authorizeModeration(request: Request, eventId: string): Promise<Response | null> {
  const token = request.headers.get(MODERATOR_HEADER);
  if (token) {
    if (await verifyModeratorToken(eventId, token)) return null;
    return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
  }
  const auth = await requireMember(request, "moderate");
  if (!auth.ok) return auth.response;
  if (!isUuid(eventId) || !(await findOwnedEvent(eventId, auth.workspaceId))) {
    return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });
  }
  return null;
}
