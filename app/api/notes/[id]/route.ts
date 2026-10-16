import { isUuid } from "@/lib/events";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { deleteNote, editNote, findNoteEventId, type NoteResult } from "@/lib/shared-notes";

const NOTE_IP_LIMIT = 100;
const NOTE_TOKEN_LIMIT = 20;
const NOTE_WINDOW_SECONDS = 60;

type Context = { params: Promise<{ id: string }> };

const tooMany = (retryAfterSeconds: number) =>
  Response.json(
    { error: "Too many requests" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

/** Resolves the caller's participant id for the note's event, or an error response. */
async function authorize(request: Request, { params }: Context) {
  const { id } = await params;
  const ip = await rateLimit(`notes:ip:${clientIp(request)}`, NOTE_IP_LIMIT, NOTE_WINDOW_SECONDS);
  if (!ip.allowed) return tooMany(ip.retryAfterSeconds);

  const eventId = isUuid(id) ? await findNoteEventId(id) : null;
  if (!eventId) return Response.json({ error: "Note not found" }, { status: 404 });

  const token = readParticipantToken(request, eventId);
  const participantId = token ? verifyParticipantToken(token, eventId) : null;
  if (!participantId) return Response.json({ error: "Not joined" }, { status: 401 });

  const byToken = await rateLimit(`notes:token:${participantId}`, NOTE_TOKEN_LIMIT, NOTE_WINDOW_SECONDS);
  if (!byToken.allowed) return tooMany(byToken.retryAfterSeconds);
  return { noteId: id, participantId };
}

const failure = (result: Extract<NoteResult, { ok: false }>) =>
  Response.json({ error: result.error }, { status: result.status });

export async function PATCH(request: Request, context: Context) {
  const auth = await authorize(request, context);
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => null);
  const text = body && typeof body === "object" ? (body as Record<string, unknown>).text : undefined;
  const result = await editNote(auth.noteId, auth.participantId, text);
  return result.ok ? Response.json({ note: result.note }) : failure(result);
}

export async function DELETE(request: Request, context: Context) {
  const auth = await authorize(request, context);
  if (auth instanceof Response) return auth;
  const result = await deleteNote(auth.noteId, auth.participantId);
  return result.ok ? new Response(null, { status: 204 }) : failure(result);
}
