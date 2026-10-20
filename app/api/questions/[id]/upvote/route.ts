import { serverT, apiMessage } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { questions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { AUDIENCE_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";
import { toggleUpvote } from "@/lib/questions";

const UPVOTE_IP_LIMIT = AUDIENCE_IP_LIMIT;
const UPVOTE_TOKEN_LIMIT = 30;
const UPVOTE_WINDOW_SECONDS = 60;

const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyRequests") },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

/** Toggles the caller's upvote: the first call adds it, the next removes it. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const ip = await rateLimit(`upvote:ip:${clientIp(request)}`, UPVOTE_IP_LIMIT, UPVOTE_WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  if (!isUuid(id)) return Response.json({ error: serverT(request, "api.questionNotFound") }, { status: 404 });
  // The participant cookie is per event, so the event comes from the question itself.
  const [question] = await getDb()
    .select({ eventId: questions.eventId })
    .from(questions)
    .where(eq(questions.id, id));
  if (!question) return Response.json({ error: serverT(request, "api.questionNotFound") }, { status: 404 });

  const token = readParticipantToken(request, question.eventId);
  const participantId = token ? verifyParticipantToken(token, question.eventId) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`upvote:token:${participantId}`, UPVOTE_TOKEN_LIMIT, UPVOTE_WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const result = await toggleUpvote(id, participantId);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ ok: true, upvoted: result.upvoted, upvotes: result.upvotes });
}
