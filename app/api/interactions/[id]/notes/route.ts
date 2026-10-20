import { serverT, apiMessage } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { AUDIENCE_IP_LIMIT, AUDIENCE_READ_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";
import { listNotes, submitNote, type NoteSort } from "@/lib/shared-notes";

const NOTE_IP_LIMIT = AUDIENCE_IP_LIMIT;
const NOTE_TOKEN_LIMIT = 10;
const NOTE_WINDOW_SECONDS = 60;

type Context = { params: Promise<{ id: string }> };

const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyRequests") },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

async function findNotesInteraction(id: string) {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select({ eventId: interactions.eventId, type: interactions.type })
    .from(interactions)
    .where(eq(interactions.id, id));
  return row && row.type === "sharedNotes" ? row : null;
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`notes:ip:${clientIp(request)}`, NOTE_IP_LIMIT, NOTE_WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const interaction = await findNotesInteraction(id);
  if (!interaction) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const byToken = await rateLimit(`notes:token:${participantId}`, NOTE_TOKEN_LIMIT, NOTE_WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(request, byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const result = await submitNote(id, participantId, fields.text, fields.authorName);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ note: result.note }, { status: 201 });
}

const LIST_IP_LIMIT = AUDIENCE_READ_IP_LIMIT;

export async function GET(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`notes:list:ip:${clientIp(request)}`, LIST_IP_LIMIT, NOTE_WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(request, ip.retryAfterSeconds);

  const interaction = await findNotesInteraction(id);
  if (!interaction) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  const sortParam = new URL(request.url).searchParams.get("sort");
  if (sortParam !== null && sortParam !== "popular" && sortParam !== "recent") {
    return Response.json({ error: serverT(request, "api.sortInvalid") }, { status: 400 });
  }
  const sort: NoteSort = sortParam ?? "popular";

  const result = await listNotes(id, participantId, sort);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ notes: result.notes });
}
