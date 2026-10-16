import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getSessionUser } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { findOwnedEvent } from "@/lib/polls";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { getWordcloudResults, submitWord } from "@/lib/wordclouds";

const WORD_IP_LIMIT = 100;
const WORD_TOKEN_LIMIT = 20;
const WORD_WINDOW_SECONDS = 60;

const notFound = () => Response.json({ error: "Interaction not found" }, { status: 404 });
const tooMany = (retryAfterSeconds: number) =>
  Response.json(
    { error: "Too many requests. Wait a moment, then try again." },
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
  if (!ip.allowed) return tooMany(ip.retryAfterSeconds);

  const interaction = await findWordcloud(id);
  if (!interaction) return notFound();

  const participantId = participantFor(request, interaction.eventId);
  if (!participantId) return Response.json({ error: "Join the event first, then try again." }, { status: 401 });

  const byToken = await rateLimit(`words:token:${participantId}`, WORD_TOKEN_LIMIT, WORD_WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const word = body && typeof body === "object" ? (body as Record<string, unknown>).word : undefined;

  const result = await submitWord(id, participantId, word);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, remaining: result.remaining }, { status: 201 });
}

/** Merged word counts for the event's participants and its host. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  const interaction = await findWordcloud(id);
  if (!interaction) return notFound();

  if (!participantFor(request, interaction.eventId)) {
    const user = await getSessionUser(request);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await findOwnedEvent(interaction.eventId, user.id))) return notFound();
  }
  const { words, total } = await getWordcloudResults(id);
  return Response.json({ words, total });
}
