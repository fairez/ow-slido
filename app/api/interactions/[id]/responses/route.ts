import { serverT, apiMessage } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { forbidden, getSessionMember } from "@/lib/auth/require-admin";
import { can } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { listResponses, listResponsesForHost, submitResponse } from "@/lib/open-text";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { AUDIENCE_IP_LIMIT, AUDIENCE_READ_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";

const IP_LIMIT = AUDIENCE_IP_LIMIT;
const TOKEN_LIMIT = 10;
const LIST_IP_LIMIT = AUDIENCE_READ_IP_LIMIT;
const WINDOW_SECONDS = 60;

type Context = { params: Promise<{ id: string }> };

const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyRequests") },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

async function findOpenTextInteraction(id: string) {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select({ eventId: interactions.eventId, type: interactions.type })
    .from(interactions)
    .where(eq(interactions.id, id));
  return row && row.type === "openText" ? row : null;
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`responses:ip:${clientIp(request)}`, IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const interaction = await findOpenTextInteraction(id);
  if (!interaction) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`responses:token:${participantId}`, TOKEN_LIMIT, WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const text = body && typeof body === "object" ? (body as Record<string, unknown>).text : undefined;

  const result = await submitResponse(id, participantId, text);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ response: result.response }, { status: 201 });
}

/** Participants get visible responses; the owning host (session) also gets hidden ones, flagged. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`responses:list:ip:${clientIp(request)}`, LIST_IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const interaction = await findOpenTextInteraction(id);
  if (!interaction) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (participantId) {
    const result = await listResponses(id, participantId);
    if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
    return Response.json({ responses: result.responses });
  }

  const member = await getSessionMember(request);
  if (!member) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });
  if (!can(member.role, "results.view")) return forbidden(request);
  const result = await listResponsesForHost(id, member.workspaceId);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ responses: result.responses });
}
