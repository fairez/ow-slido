import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { listNotes, submitNote, type NoteSort } from "@/lib/shared-notes";

const NOTE_IP_LIMIT = 100;
const NOTE_TOKEN_LIMIT = 10;
const NOTE_WINDOW_SECONDS = 60;

type Context = { params: Promise<{ id: string }> };

const tooMany = (retryAfterSeconds: number) =>
  Response.json(
    { error: "Too many requests" },
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
  if (!ip.allowed) return tooMany(ip.retryAfterSeconds);

  const interaction = await findNotesInteraction(id);
  if (!interaction) return Response.json({ error: "Interaction not found" }, { status: 404 });

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (!participantId) return Response.json({ error: "Not joined" }, { status: 401 });

  const byToken = await rateLimit(`notes:token:${participantId}`, NOTE_TOKEN_LIMIT, NOTE_WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(byToken.retryAfterSeconds);

  const body = await request.json().catch(() => null);
  const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const result = await submitNote(id, participantId, fields.text, fields.authorName);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ note: result.note }, { status: 201 });
}

const LIST_IP_LIMIT = 200;

export async function GET(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`notes:list:ip:${clientIp(request)}`, LIST_IP_LIMIT, NOTE_WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(ip.retryAfterSeconds);

  const interaction = await findNotesInteraction(id);
  if (!interaction) return Response.json({ error: "Interaction not found" }, { status: 404 });

  const token = readParticipantToken(request, interaction.eventId);
  const participantId = token ? verifyParticipantToken(token, interaction.eventId) : null;
  if (!participantId) return Response.json({ error: "Not joined" }, { status: 401 });

  const sortParam = new URL(request.url).searchParams.get("sort");
  if (sortParam !== null && sortParam !== "popular" && sortParam !== "recent") {
    return Response.json({ error: "sort must be popular or recent" }, { status: 400 });
  }
  const sort: NoteSort = sortParam ?? "popular";

  const result = await listNotes(id, participantId, sort);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ notes: result.notes });
}
