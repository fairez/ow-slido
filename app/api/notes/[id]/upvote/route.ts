import { serverT, apiMessage } from "@/lib/i18n/server";
import { isUuid } from "@/lib/events";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { AUDIENCE_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";
import { findNoteEventId, toggleNoteUpvote } from "@/lib/shared-notes";

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

  const ip = await rateLimit(`note-upvote:ip:${clientIp(request)}`, UPVOTE_IP_LIMIT, UPVOTE_WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const eventId = isUuid(id) ? await findNoteEventId(id) : null;
  if (!eventId) return Response.json({ error: serverT(request, "api.noteNotFound") }, { status: 404 });

  const token = readParticipantToken(request, eventId);
  const participantId = token ? verifyParticipantToken(token, eventId) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`note-upvote:token:${participantId}`, UPVOTE_TOKEN_LIMIT, UPVOTE_WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const result = await toggleNoteUpvote(id, participantId);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ ok: true, upvoted: result.upvoted, upvotes: result.upvotes });
}
