import { and, eq } from "drizzle-orm";
import { events, participants } from "@/db/schema";
import { isSecureRequest } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import {
  participantSetCookie,
  readParticipantToken,
  verifyParticipantToken,
} from "@/lib/participant-token";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const JOIN_LIMIT = 30;
const JOIN_WINDOW_SECONDS = 60;

const notFound = () => Response.json({ error: "Event not found" }, { status: 404 });

export async function POST(request: Request) {
  const limit = await rateLimit(`join:ip:${clientIp(request)}`, JOIN_LIMIT, JOIN_WINDOW_SECONDS);
  if (!limit.allowed) {
    return Response.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^[0-9]{4,6}$/.test(code)) return notFound();

  const db = getDb();
  const [event] = await db.select().from(events).where(eq(events.joinCode, code));
  if (!event) return notFound();

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
    const [created] = await db
      .insert(participants)
      .values({ eventId: event.id })
      .returning({ id: participants.id });
    participantId = created.id;
  }

  return Response.json(
    {
      event: { id: event.id, name: event.name, joinCode: event.joinCode },
      participant: { id: participantId },
    },
    { headers: { "set-cookie": participantSetCookie(event.id, participantId, isSecureRequest(request)) } },
  );
}
