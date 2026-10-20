import { serverT, apiMessage } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { forbidden, getSessionMember } from "@/lib/auth/require-admin";
import { can } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { findOwnedEvent } from "@/lib/polls";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { AUDIENCE_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";
import { getWordcloudResults, submitWord } from "@/lib/wordclouds";

const WORD_IP_LIMIT = AUDIENCE_IP_LIMIT;
const WORD_TOKEN_LIMIT = 20;
const WORD_WINDOW_SECONDS = 60;

const notFound = (request: Request) => Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });
const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyRequests") },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

type Context = { params: Promise<{ id: string }> };

async function findWordcloud(id: string) {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select({ eventId: interactions.eventId, type: interactions.type })
    .from(interactions)
    .where(eq(interactions.id, id));
  return row && row.type === "wordcloud" ? row : null;
}

/** The participant id from the event cookie, or null. */
function participantFor(request: Request, eventId: string) {
  const token = readParticipantToken(request, eventId);
  return token ? verifyParticipantToken(token, eventId) : null;
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`words:ip:${clientIp(request)}`, WORD_IP_LIMIT, WORD_WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const interaction = await findWordcloud(id);
  if (!interaction) return notFound(request);

  const participantId = participantFor(request, interaction.eventId);
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`words:token:${participantId}`, WORD_TOKEN_LIMIT, WORD_WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const word = body && typeof body === "object" ? (body as Record<string, unknown>).word : undefined;

  const result = await submitWord(id, participantId, word);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ ok: true, remaining: result.remaining }, { status: 201 });
}

/** Merged word counts for the event's participants and its host. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  const interaction = await findWordcloud(id);
  if (!interaction) return notFound(request);

  if (!participantFor(request, interaction.eventId)) {
    const member = await getSessionMember(request);
    if (!member) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
    if (!can(member.role, "results.view")) return forbidden(request);
    if (!(await findOwnedEvent(interaction.eventId, member.workspaceId))) return notFound(request);
  }
  const { words, total } = await getWordcloudResults(id);
  return Response.json({ words, total });
}
