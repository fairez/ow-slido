import { and, eq } from "drizzle-orm";
import { events, participants } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { getLiveInteraction } from "@/lib/live-view";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";

/** The interaction currently live for this event, for a participant loading or reconnecting. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "Event not found" }, { status: 404 });
  const db = getDb();
  const [event] = await db.select({ id: events.id }).from(events).where(eq(events.id, id));
  if (!event) return Response.json({ error: "Event not found" }, { status: 404 });

  const token = readParticipantToken(request, id);
  const participantId = token ? verifyParticipantToken(token, id) : null;
  if (!participantId) return Response.json({ error: "Not joined" }, { status: 401 });
  const [participant] = await db
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.eventId, id)));
  if (!participant) return Response.json({ error: "Not joined" }, { status: 401 });

  return Response.json({ interaction: await getLiveInteraction(id) });
}
