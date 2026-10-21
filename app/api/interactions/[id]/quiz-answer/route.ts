import { serverT, apiMessage } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { submitQuizAnswer } from "@/lib/quiz";
import { eventUnavailableResponse } from "@/lib/workspace-suspension";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { AUDIENCE_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";

const TOKEN_LIMIT = 10;
const WINDOW_SECONDS = 60;

type Context = { params: Promise<{ id: string }> };

const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyRequests") },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

async function findQuizInteraction(id: string) {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select({ eventId: interactions.eventId, type: interactions.type })
    .from(interactions)
    .where(eq(interactions.id, id));
  return row && row.type === "quiz" ? row : null;
}

/** A participant answers a quiz question, once. */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`quiz:ip:${clientIp(request)}`, AUDIENCE_IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const interaction = await findQuizInteraction(id);
  if (!interaction) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });

  const unavailable = await eventUnavailableResponse(request, interaction.eventId);

  if (unavailable) return unavailable;

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`quiz:token:${participantId}`, TOKEN_LIMIT, WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const optionIds = body && typeof body === "object" ? (body as Record<string, unknown>).optionIds : undefined;

  const result = await submitQuizAnswer(id, participantId, optionIds);
  if (!result.ok) {
    // The client keys on `reason`, not on the translated text.
    const reason = result.error === "api.alreadyAnswered" ? "alreadyAnswered" : result.error === "api.quizTimeUp" ? "timeUp" : undefined;
    return Response.json({ error: apiMessage(request, result), ...(reason && { reason }) }, { status: result.status });
  }
  return Response.json({ ok: true }, { status: 201 });
}
