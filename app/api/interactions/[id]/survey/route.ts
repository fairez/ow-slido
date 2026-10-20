import { serverT, apiMessage } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { submitSurvey } from "@/lib/survey";
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

async function findSurveyInteraction(id: string) {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select({ eventId: interactions.eventId, type: interactions.type })
    .from(interactions)
    .where(eq(interactions.id, id));
  return row && row.type === "survey" ? row : null;
}

/** A participant submits the whole survey, once. */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`survey:ip:${clientIp(request)}`, AUDIENCE_IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const interaction = await findSurveyInteraction(id);
  if (!interaction) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`survey:token:${participantId}`, TOKEN_LIMIT, WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const answers = body && typeof body === "object" ? (body as Record<string, unknown>).answers : undefined;

  const result = await submitSurvey(id, participantId, answers);
  if (!result.ok) {
    const { questionId, missing } = result;
    return Response.json(
      {
        error: apiMessage(request, result),
        ...(result.error === "api.alreadySubmitted" && { reason: "alreadySubmitted" }),
        ...(questionId && { questionId }),
        ...(missing && { missing }),
      },
      { status: result.status },
    );
  }
  return Response.json({ ok: true }, { status: 201 });
}
