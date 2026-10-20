import { serverT, apiMessage } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { eventUnavailableResponse } from "@/lib/workspace-suspension";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { AUDIENCE_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";
import { castVote } from "@/lib/votes";

const VOTE_IP_LIMIT = AUDIENCE_IP_LIMIT;
const VOTE_TOKEN_LIMIT = 20;
const VOTE_WINDOW_SECONDS = 60;

const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyRequests") },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const ip = await rateLimit(`vote:ip:${clientIp(request)}`, VOTE_IP_LIMIT, VOTE_WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  if (!isUuid(id)) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });
  // The participant cookie is per event, so the event comes from the interaction itself.
  const [interaction] = await getDb()
    .select({ eventId: interactions.eventId })
    .from(interactions)
    .where(eq(interactions.id, id));
  if (!interaction) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });

  const unavailable = await eventUnavailableResponse(request, interaction.eventId);

  if (unavailable) return unavailable;

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`vote:token:${participantId}`, VOTE_TOKEN_LIMIT, VOTE_WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: serverT(request, "api.invalidBody") }, { status: 400 });
  }
  const optionIds = body && typeof body === "object" ? (body as Record<string, unknown>).optionIds : undefined;

  const result = await castVote(id, participantId, optionIds);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ ok: true, counts: result.counts.counts, total: result.counts.total }, { status: 201 });
}
