import { auditContext, recordAudit } from "@/lib/audit";
import { requireMember } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { serverT } from "@/lib/i18n/server";
import { deleteParticipantData } from "@/lib/participant-data";
import { eventNotFound, findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string; participantId: string }> };

/** Erases one participant's data from the event (responses, votes, notes, questions, quiz and survey answers). */
export async function DELETE(request: Request, { params }: Context) {
  const auth = await requireMember(request, "event.edit");
  if (!auth.ok) return auth.response;
  const { id, participantId } = await params;
  const event = await findOwnedEvent(id, auth.workspaceId);
  if (!event) return eventNotFound(request);
  const result = isUuid(participantId) ? await deleteParticipantData(event.id, participantId) : null;
  if (!result) return Response.json({ error: serverT(request, "api.participantNotFound") }, { status: 404 });

  await recordAudit(undefined, {
    ...auditContext(request, auth.user),
    workspaceId: auth.workspaceId,
    action: "participant.data_deleted",
    targetType: "participant",
    targetId: participantId,
    metadata: { eventId: event.id, removedCount: result.removed },
  });
  return Response.json({ ok: true, removed: result.removed });
}
