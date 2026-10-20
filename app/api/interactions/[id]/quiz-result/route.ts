import { serverT } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { getQuizOutcome } from "@/lib/quiz";
import { eventUnavailableResponse } from "@/lib/workspace-suspension";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";

type Context = { params: Promise<{ id: string }> };

/** A participant's own result for a closed quiz question: correct or not, points, and the correct options. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });
  const [row] = await getDb()
    .select({ eventId: interactions.eventId, type: interactions.type })
    .from(interactions)
    .where(eq(interactions.id, id));
  if (!row || row.type !== "quiz") {
    return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });
  }

  const unavailable = await eventUnavailableResponse(request, row.eventId);

  if (unavailable) return unavailable;

  const token = readParticipantToken(request, row.eventId);
  const participantId = token ? verifyParticipantToken(token, row.eventId) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const outcome = await getQuizOutcome(id, participantId);
  if (!outcome) return Response.json({ error: serverT(request, "api.quizResultNotReady") }, { status: 409 });
  return Response.json(outcome);
}
