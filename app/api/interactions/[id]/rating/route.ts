import { serverT, apiMessage } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { forbidden, getSessionMember } from "@/lib/auth/require-admin";
import { can } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { getResultsForHost, getResultsForParticipant, submitRating } from "@/lib/rating";
import { eventUnavailableResponse } from "@/lib/workspace-suspension";
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

async function findRatingInteraction(id: string) {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select({ eventId: interactions.eventId, type: interactions.type })
    .from(interactions)
    .where(eq(interactions.id, id));
  return row && row.type === "rating" ? row : null;
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`rating:ip:${clientIp(request)}`, IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const interaction = await findRatingInteraction(id);
  if (!interaction) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });

  const unavailable = await eventUnavailableResponse(request, interaction.eventId);

  if (unavailable) return unavailable;

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`rating:token:${participantId}`, TOKEN_LIMIT, WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const value = body && typeof body === "object" ? (body as Record<string, unknown>).value : undefined;

  const result = await submitRating(id, participantId, value);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ value: result.value, results: result.results }, { status: 201 });
}

/** Aggregates: a joined participant also gets their own rating; otherwise the owning host session. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`rating:list:ip:${clientIp(request)}`, LIST_IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const interaction = await findRatingInteraction(id);
  if (!interaction) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });

  const unavailable = await eventUnavailableResponse(request, interaction.eventId);

  if (unavailable) return unavailable;

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (participantId) {
    const result = await getResultsForParticipant(id, participantId);
    if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
    return Response.json({ results: result.results, mine: result.mine });
  }

  const member = await getSessionMember(request);
  if (!member) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });
  if (!can(member.role, "results.view")) return forbidden(request);
  const result = await getResultsForHost(id, member.workspaceId);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ results: result.results, mine: result.mine });
}
