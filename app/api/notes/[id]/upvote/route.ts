import { isUuid } from "@/lib/events";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { findNoteEventId, toggleNoteUpvote } from "@/lib/shared-notes";

const UPVOTE_IP_LIMIT = 100;
const UPVOTE_TOKEN_LIMIT = 30;
const UPVOTE_WINDOW_SECONDS = 60;

const tooMany = (retryAfterSeconds: number) =>
  Response.json(
    { error: "Too many requests. Wait a moment, then try again." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

/** Toggles the caller's upvote: the first call adds it, the next removes it. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const ip = await rateLimit(`note-upvote:ip:${clientIp(request)}`, UPVOTE_IP_LIMIT, UPVOTE_WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(ip.retryAfterSeconds);

  const eventId = isUuid(id) ? await findNoteEventId(id) : null;
  if (!eventId) return Response.json({ error: "Note not found" }, { status: 404 });

  const token = readParticipantToken(request, eventId);
  const participantId = token ? verifyParticipantToken(token, eventId) : null;
  if (!participantId) return Response.json({ error: "Join the event first, then try again." }, { status: 401 });

  const byToken = await rateLimit(`note-upvote:token:${participantId}`, UPVOTE_TOKEN_LIMIT, UPVOTE_WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(byToken.retryAfterSeconds);

  const result = await toggleNoteUpvote(id, participantId);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, upvoted: result.upvoted, upvotes: result.upvotes });
}
