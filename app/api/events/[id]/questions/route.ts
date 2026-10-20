import { serverT, apiMessage } from "@/lib/i18n/server";
import { getSessionMember } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { findOwnedEvent } from "@/lib/polls";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { AUDIENCE_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";
import { listApprovedQuestions, submitQuestion } from "@/lib/questions";

const QUESTION_IP_LIMIT = AUDIENCE_IP_LIMIT;
const QUESTION_TOKEN_LIMIT = 5;
const QUESTION_WINDOW_SECONDS = 60;

type Context = { params: Promise<{ id: string }> };

const notFound = (request: Request) => Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });
const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyRequests") },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

function participantFor(request: Request, eventId: string) {
  const token = readParticipantToken(request, eventId);
  return token ? verifyParticipantToken(token, eventId) : null;
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  if (!isUuid(id)) return notFound(request);

  const ip = await rateLimit(`question:ip:${clientIp(request)}`, QUESTION_IP_LIMIT, QUESTION_WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const participantId = participantFor(request, id);
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(
    `question:token:${participantId}`,
    QUESTION_TOKEN_LIMIT,
    QUESTION_WINDOW_SECONDS,
  );
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const result = await submitQuestion(id, participantId, input);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  // A pending question is echoed only to its author; it is not listed anywhere else.
  return Response.json({ ok: true, status: result.status, question: result.question }, { status: 201 });
}

/** Approved questions for the event's participants and its host. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  if (!isUuid(id)) return notFound(request);

  const participantId = participantFor(request, id);
  if (!participantId) {
    const member = await getSessionMember(request);
    if (!member) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
    if (!(await findOwnedEvent(id, member.workspaceId))) return notFound(request);
  }
  return Response.json({ questions: await listApprovedQuestions(id, participantId ?? undefined) });
}
