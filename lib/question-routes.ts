import { eq } from "drizzle-orm";
import { events, questions } from "@/db/schema";
import { can } from "@/lib/auth/permissions";
import { forbidden, getSessionMember } from "@/lib/auth/require-admin";
import { authorizeModeration } from "@/lib/auth/require-moderation";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { apiMessage, serverT } from "@/lib/i18n/server";
import { deleteQuestion, listHostQuestions, moderateQuestion } from "@/lib/moderation";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { findOwnedEvent } from "@/lib/polls";
import {
  ensureQaInteraction,
  findQaInteraction,
  listApprovedQuestions,
  resolveEventQa,
  submitQuestion,
  toggleUpvote,
} from "@/lib/questions";
import { AUDIENCE_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * The question routes, written once. `/api/interactions/[id]/questions/**` passes the Q&A id it was given; the
 * older `/api/events/[id]/questions/**` paths resolve the event's live (else first) Q&A and call the same code.
 */

const QUESTION_IP_LIMIT = AUDIENCE_IP_LIMIT;
const QUESTION_TOKEN_LIMIT = 5;
const UPVOTE_IP_LIMIT = AUDIENCE_IP_LIMIT;
const UPVOTE_TOKEN_LIMIT = 30;
const WINDOW_SECONDS = 60;

const notFound = (request: Request, key: "api.eventNotFound" | "api.interactionNotFound" | "api.questionNotFound") =>
  Response.json({ error: serverT(request, key) }, { status: 404 });
const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyRequests") },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

function participantFor(request: Request, eventId: string) {
  const token = readParticipantToken(request, eventId);
  return token ? verifyParticipantToken(token, eventId) : null;
}

/** The Q&A an event-level path stands for, or the 404 to answer when the event is unknown or has none. */
export async function qaForEventPath(
  request: Request,
  eventId: string,
): Promise<{ interactionId: string } | { response: Response }> {
  if (!isUuid(eventId)) return { response: notFound(request, "api.eventNotFound") };
  const interactionId = await resolveEventQa(getDb(), eventId);
  return interactionId ? { interactionId } : { response: notFound(request, "api.interactionNotFound") };
}

/**
 * Participant asks a question. With `interactionId` null (the event-level path) the event's Q&A is resolved, and
 * created if the event has none, but only once the caller proved to be a participant.
 */
export async function postQuestion(request: Request, eventId: string, interactionId: string | null): Promise<Response> {
  const ip = await rateLimit(`question:ip:${clientIp(request)}`, QUESTION_IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const participantId = participantFor(request, eventId);
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`question:token:${participantId}`, QUESTION_TOKEN_LIMIT, WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  if (!interactionId) {
    if (!(await eventExists(eventId))) return notFound(request, "api.eventNotFound");
    interactionId = await ensureQaInteraction(getDb(), eventId);
  }
  const result = await submitQuestion(interactionId, participantId, input);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  // A pending question is echoed only to its author; it is not listed anywhere else.
  return Response.json(
    { ok: true, status: result.status, interactionId, question: result.question },
    { status: 201 },
  );
}

/** Approved questions for the event's participants and its host. `interactionId` is null when the event has no Q&A. */
export async function getQuestions(request: Request, eventId: string, interactionId: string | null): Promise<Response> {
  const participantId = participantFor(request, eventId);
  if (!participantId) {
    const member = await getSessionMember(request);
    if (!member) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
    if (!can(member.role, "results.view")) return forbidden(request);
    if (!(await findOwnedEvent(eventId, member.workspaceId))) return notFound(request, "api.eventNotFound");
  }
  const list = interactionId ? await listApprovedQuestions(interactionId, participantId ?? undefined) : [];
  return Response.json({ interactionId, questions: list });
}

/** Host or moderator: pending and approved questions of one Q&A. */
export async function getQuestionQueue(request: Request, interactionId: string, eventId: string): Promise<Response> {
  const denied = await authorizeModeration(request, eventId);
  if (denied) return denied;
  return Response.json({ interactionId, questions: await listHostQuestions(interactionId) });
}

/** Host or moderator: approve/reject a pending question, or pin / mark answered an approved one. */
export async function patchQuestion(
  request: Request,
  eventId: string,
  interactionId: string,
  questionId: string,
): Promise<Response> {
  const denied = await authorizeModeration(request, eventId);
  if (denied) return denied;
  if (!isUuid(questionId)) return notFound(request, "api.questionNotFound");
  const body = await request.json().catch(() => null);
  const change = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const result = await moderateQuestion(interactionId, questionId, change);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ ok: true, question: result.question });
}

export async function removeQuestion(
  request: Request,
  eventId: string,
  interactionId: string,
  questionId: string,
): Promise<Response> {
  const denied = await authorizeModeration(request, eventId);
  if (denied) return denied;
  if (!isUuid(questionId) || !(await deleteQuestion(interactionId, questionId))) {
    return notFound(request, "api.questionNotFound");
  }
  return new Response(null, { status: 204 });
}

/** The Q&A a question sits in, looked up inside an event (the event-level moderation paths). */
export async function interactionOfQuestion(eventId: string, questionId: string): Promise<string | null> {
  if (!isUuid(questionId)) return null;
  const [row] = await getDb()
    .select({ interactionId: questions.interactionId, eventId: questions.eventId })
    .from(questions)
    .where(eq(questions.id, questionId));
  return row && row.eventId === eventId ? row.interactionId : null;
}

/** Toggles the caller's upvote: the first call adds it, the next removes it. */
export async function postUpvote(request: Request, questionId: string, interactionId?: string): Promise<Response> {
  const ip = await rateLimit(`upvote:ip:${clientIp(request)}`, UPVOTE_IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  if (!isUuid(questionId)) return notFound(request, "api.questionNotFound");
  // The participant cookie is per event, so the event comes from the question itself.
  const [question] = await getDb()
    .select({ eventId: questions.eventId, interactionId: questions.interactionId })
    .from(questions)
    .where(eq(questions.id, questionId));
  if (!question || (interactionId && question.interactionId !== interactionId)) {
    return notFound(request, "api.questionNotFound");
  }

  const participantId = participantFor(request, question.eventId);
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`upvote:token:${participantId}`, UPVOTE_TOKEN_LIMIT, WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const result = await toggleUpvote(questionId, participantId, interactionId);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ ok: true, upvoted: result.upvoted, upvotes: result.upvotes });
}

/** Loads a Q&A for an interaction-level path, or the 404 to answer. */
export async function qaOr404(request: Request, interactionId: string) {
  const qa = await findQaInteraction(interactionId);
  return qa ?? { response: notFound(request, "api.interactionNotFound") };
}

/** Event existence check for the event-level submit path (an unknown event must not reach the insert). */
export async function eventExists(eventId: string): Promise<boolean> {
  if (!isUuid(eventId)) return false;
  const [row] = await getDb().select({ id: events.id }).from(events).where(eq(events.id, eventId));
  return Boolean(row);
}
