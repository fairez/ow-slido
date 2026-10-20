import { serverT } from "@/lib/i18n/server";
import { requireMember } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { findOwnedEvent } from "@/lib/polls";

/** Access to one event's moderation queue: a member of the event's workspace whose role holds `moderate`. */
export async function authorizeModeration(request: Request, eventId: string): Promise<Response | null> {
  const auth = await requireMember(request, "moderate");
  if (!auth.ok) return auth.response;
  if (!isUuid(eventId) || !(await findOwnedEvent(eventId, auth.workspaceId))) {
    return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });
  }
  return null;
}
