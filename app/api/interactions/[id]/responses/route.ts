import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getSessionUser } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { listResponses, listResponsesForHost, submitResponse } from "@/lib/open-text";
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

async function findOpenTextInteraction(id: string) {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select({ eventId: interactions.eventId, type: interactions.type })
    .from(interactions)
    .where(eq(interactions.id, id));
  return row && row.type === "openText" ? row : null;
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`responses:ip:${clientIp(request)}`, IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(ip.retryAfterSeconds);

  const interaction = await findOpenTextInteraction(id);
  if (!interaction) return Response.json({ error: "Interaction not found" }, { status: 404 });

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (!participantId) return Response.json({ error: "Join the event first, then try again." }, { status: 401 });

  const byToken = await rateLimit(`responses:token:${participantId}`, TOKEN_LIMIT, WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const text = body && typeof body === "object" ? (body as Record<string, unknown>).text : undefined;

  const result = await submitResponse(id, participantId, text);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ response: result.response }, { status: 201 });
}

/** Participants get visible responses; the owning host (session) also gets hidden ones, flagged. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`responses:list:ip:${clientIp(request)}`, LIST_IP_LIMIT, WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(ip.retryAfterSeconds);

  const interaction = await findOpenTextInteraction(id);
  if (!interaction) return Response.json({ error: "Interaction not found" }, { status: 404 });

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (participantId) {
    const result = await listResponses(id, participantId);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ responses: result.responses });
  }

  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: "Join the event first, then try again." }, { status: 401 });
  const result = await listResponsesForHost(id, user.id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ responses: result.responses });
}
