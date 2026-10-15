import { getSessionUser } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { findOwnedEvent } from "@/lib/polls";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { listApprovedQuestions, submitQuestion } from "@/lib/questions";

const QUESTION_IP_LIMIT = 100;
const QUESTION_TOKEN_LIMIT = 5;
const QUESTION_WINDOW_SECONDS = 60;

type Context = { params: Promise<{ id: string }> };

const notFound = () => Response.json({ error: "Event not found" }, { status: 404 });
const tooMany = (retryAfterSeconds: number) =>
  Response.json(
    { error: "Too many requests" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

function participantFor(request: Request, eventId: string) {
  const token = readParticipantToken(request, eventId);
  return token ? verifyParticipantToken(token, eventId) : null;
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const ip = await rateLimit(`question:ip:${clientIp(request)}`, QUESTION_IP_LIMIT, QUESTION_WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(ip.retryAfterSeconds);

  const participantId = participantFor(request, id);
  if (!participantId) return Response.json({ error: "Not joined" }, { status: 401 });

  const byToken = await rateLimit(
    `question:token:${participantId}`,
    QUESTION_TOKEN_LIMIT,
    QUESTION_WINDOW_SECONDS,
  );
  if (!byToken.allowed) return tooMany(byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const result = await submitQuestion(id, participantId, input);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  // A pending question is echoed only to its author; it is not listed anywhere else.
  return Response.json({ ok: true, status: result.status, question: result.question }, { status: 201 });
}

/** Approved questions for the event's participants and its host. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const participantId = participantFor(request, id);
  if (!participantId) {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await findOwnedEvent(id, user.id))) return notFound();
  }
  return Response.json({ questions: await listApprovedQuestions(id, participantId ?? undefined) });
}
