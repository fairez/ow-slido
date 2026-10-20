import { serverT } from "@/lib/i18n/server";
import { and, eq, sql } from "drizzle-orm";
import { events, participants } from "@/db/schema";
import { isSecureRequest } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { PlanLimitError, assertParticipantSlot } from "@/lib/limits";
import {
  participantSetCookie,
  readParticipantToken,
  verifyParticipantToken,
} from "@/lib/participant-token";
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

  let participantId: string | null = null;
  const token = readParticipantToken(request, event.id);
  const tokenParticipantId = token ? verifyParticipantToken(token, event.id) : null;
  if (tokenParticipantId && isUuid(tokenParticipantId)) {
    const [existing] = await db
      .select({ id: participants.id })
      .from(participants)
      .where(and(eq(participants.id, tokenParticipantId), eq(participants.eventId, event.id)));
    participantId = existing?.id ?? null;
  }
  if (!participantId) {
    try {
      participantId = await db.transaction(async (tx) => {
        // One lock per event, so two joins cannot both take the last slot.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${event.id}))`);
        await assertParticipantSlot(event.workspaceId, event.id, tx);
        const [created] = await tx.insert(participants).values({ eventId: event.id }).returning({ id: participants.id });
        return created.id;
      });
    } catch (error) {
      // Participants get the message only: the upgrade hint is for the host.
      if (error instanceof PlanLimitError) {
        return Response.json(
          { error: serverT(request, error.messageKey, error.params), reason: error.reason },
          { status: 403 },
        );
      }
      throw error;
    }
  }

  return Response.json(
    {
      event: { id: event.id, name: event.name, joinCode: event.joinCode },
      participant: { id: participantId },
    },
    { headers: { "set-cookie": participantSetCookie(event.id, participantId, isSecureRequest(request)) } },
  );
}
