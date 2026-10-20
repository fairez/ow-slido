import { serverT, apiMessage } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { setNickname } from "@/lib/nickname";
import { eventUnavailableResponse } from "@/lib/workspace-suspension";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { AUDIENCE_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";

const TOKEN_LIMIT = 20;
const WINDOW_SECONDS = 60;

type Context = { params: Promise<{ id: string }> };

const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyRequests") },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

/** A participant sets the display name that the quiz leaderboard shows. */
export async function PUT(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`nickname:ip:${clientIp(request)}`, AUDIENCE_IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  if (!isUuid(id)) return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });
  const [event] = await getDb().select({ id: events.id }).from(events).where(eq(events.id, id));
  if (!event) return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });

  const unavailable = await eventUnavailableResponse(request, id);

  if (unavailable) return unavailable;

  const token = readParticipantToken(request, id);
  const participantId = token ? verifyParticipantToken(token, id) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`nickname:token:${participantId}`, TOKEN_LIMIT, WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).nickname : undefined;

  const result = await setNickname(id, participantId, raw);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ nickname: result.nickname });
}
