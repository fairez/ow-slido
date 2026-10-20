import { requireMember } from "@/lib/auth/require-admin";
import { listParticipants } from "@/lib/participant-data";
import { eventNotFound, findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string }> };

/** The event's participants for the "Delete participant data" dialog; same permission as the deletion. */
export async function GET(request: Request, { params }: Context) {
  const auth = await requireMember(request, "event.edit");
  if (!auth.ok) return auth.response;
  const event = await findOwnedEvent((await params).id, auth.workspaceId);
  if (!event) return eventNotFound(request);
  return Response.json(await listParticipants(event.id));
}
