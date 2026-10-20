import { serverT } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { events, interactions } from "@/db/schema";
import { isSecureRequest } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { ensureParticipant } from "@/lib/participants";
import { participantSetCookie } from "@/lib/participant-token";
import { hasSubmitted } from "@/lib/survey-page";
import { eventUnavailableResponse } from "@/lib/workspace-suspension";
import { JOIN_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";

const WINDOW_SECONDS = 60;

type Context = { params: Promise<{ id: string }> };

/**
 * Opens the survey link for a participant: reuses the event's participant cookie or creates a participant
 * (under the plan's participant limit) and sets the cookie. Only a live survey takes people in.
 */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;

  const limit = await rateLimit(`survey-join:ip:${clientIp(request)}`, JOIN_IP_LIMIT, WINDOW_SECONDS);
  if (!limit.allowed) {
    return Response.json(
      { error: serverT(request, "api.tooManyAttempts") },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  const [row] = isUuid(id)
    ? await getDb()
        .select({ type: interactions.type, state: interactions.state, event: events })
        .from(interactions)
        .innerJoin(events, eq(events.id, interactions.eventId))
        .where(eq(interactions.id, id))
    : [];
  if (!row || row.type !== "survey") return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });
  const unavailable = await eventUnavailableResponse(request, row.event.id);
  if (unavailable) return unavailable;
  if (row.state !== "live") return Response.json({ error: serverT(request, "api.surveyNotOpen") }, { status: 409 });

  const ensured = await ensureParticipant(request, row.event);
  if (!ensured.ok) {
    return Response.json(
      { error: serverT(request, ensured.limit.messageKey, ensured.limit.params), reason: ensured.limit.reason },
      { status: 403 },
    );
  }
  return Response.json(
    { submitted: await hasSubmitted(id, ensured.participantId) },
    { headers: { "set-cookie": participantSetCookie(row.event.id, ensured.participantId, isSecureRequest(request)) } },
  );
}
