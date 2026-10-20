import { serverT } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { isSecureRequest } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { ensureParticipant } from "@/lib/participants";
import { participantSetCookie } from "@/lib/participant-token";
import { eventUnavailableResponse } from "@/lib/workspace-suspension";
import { JOIN_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";

const JOIN_WINDOW_SECONDS = 60;

const notFound = (request: Request) => Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });

export async function POST(request: Request) {
  const limit = await rateLimit(`join:ip:${clientIp(request)}`, JOIN_IP_LIMIT, JOIN_WINDOW_SECONDS);
  if (!limit.allowed) {
    // No address in the log: it is only here to tell "a room behind one IP" apart from other failures.
    console.warn("[join] per-IP rate limit reached");
    return Response.json(
      { error: serverT(request, "api.tooManyAttempts") },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^[0-9]{4,6}$/.test(code)) return notFound(request);

  const db = getDb();
  const [event] = await db.select().from(events).where(eq(events.joinCode, code));
  if (!event) return notFound(request);
  const unavailable = await eventUnavailableResponse(request, event.id);
  if (unavailable) return unavailable;

  const ensured = await ensureParticipant(request, event);
  // Participants get the message only: the upgrade hint is for the host.
  if (!ensured.ok) {
    return Response.json(
      { error: serverT(request, ensured.limit.messageKey, ensured.limit.params), reason: ensured.limit.reason },
      { status: 403 },
    );
  }
  const participantId = ensured.participantId;

  return Response.json(
    {
      event: { id: event.id, name: event.name, joinCode: event.joinCode },
      participant: { id: participantId },
    },
    { headers: { "set-cookie": participantSetCookie(event.id, participantId, isSecureRequest(request)) } },
  );
}
