import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getSessionUser } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { getResultsForHost, getResultsForParticipant, submitRating } from "@/lib/rating";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const IP_LIMIT = 100;
const TOKEN_LIMIT = 10;
const LIST_IP_LIMIT = 200;
const WINDOW_SECONDS = 60;

type Context = { params: Promise<{ id: string }> };

const tooMany = (retryAfterSeconds: number) =>
  Response.json(
    { error: "Too many requests. Wait a moment, then try again." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

async function findRatingInteraction(id: string) {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select({ eventId: interactions.eventId, type: interactions.type })
    .from(interactions)
    .where(eq(interactions.id, id));
  return row && row.type === "rating" ? row : null;
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`rating:ip:${clientIp(request)}`, IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(ip.retryAfterSeconds);

  const interaction = await findRatingInteraction(id);
  if (!interaction) return Response.json({ error: "Interaction not found" }, { status: 404 });

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (!participantId) return Response.json({ error: "Join the event first, then try again." }, { status: 401 });

  const byToken = await rateLimit(`rating:token:${participantId}`, TOKEN_LIMIT, WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const value = body && typeof body === "object" ? (body as Record<string, unknown>).value : undefined;

  const result = await submitRating(id, participantId, value);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ value: result.value, results: result.results }, { status: 201 });
}

/** Aggregates: a joined participant also gets their own rating; otherwise the owning host session. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`rating:list:ip:${clientIp(request)}`, LIST_IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(ip.retryAfterSeconds);

  const interaction = await findRatingInteraction(id);
  if (!interaction) return Response.json({ error: "Interaction not found" }, { status: 404 });

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (participantId) {
    const result = await getResultsForParticipant(id, participantId);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ results: result.results, mine: result.mine });
  }

  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: "Join the event first, then try again." }, { status: 401 });
  const result = await getResultsForHost(id, user.id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ results: result.results, mine: result.mine });
}
