import { serverT } from "@/lib/i18n/server";
import { authorizeModeration } from "@/lib/auth/require-moderation";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { listHostNotes, listHostQuestions } from "@/lib/moderation";
import { resolveEventQa } from "@/lib/questions";

/** Host or moderator: pending and approved questions (of the live, else first Q&A) and notes of the event. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await authorizeModeration(request, id);
  if (denied) return denied;
  if (!isUuid(id)) return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });
  const interactionId = await resolveEventQa(getDb(), id);
  return Response.json({
    interactionId,
    questions: interactionId ? await listHostQuestions(interactionId) : [],
    notes: await listHostNotes(id),
  });
}
