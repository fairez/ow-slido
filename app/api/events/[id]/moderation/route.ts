import { serverT } from "@/lib/i18n/server";
import { authorizeModeration } from "@/lib/auth/require-moderation";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { listHostNotes, listHostQuestions } from "@/lib/moderation";
import { findQaInteraction, resolveEventQa } from "@/lib/questions";

/**
 * Host or moderator: pending and approved questions and the notes of the event. The questions are those of the Q&A
 * named by `?interaction=`, else the live (or first) one.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await authorizeModeration(request, id);
  if (denied) return denied;
  if (!isUuid(id)) return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });
  const asked = new URL(request.url).searchParams.get("interaction");
  let interactionId: string | null;
  if (asked) {
    const qa = await findQaInteraction(asked);
    if (!qa || qa.eventId !== id) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });
    interactionId = qa.id;
  } else {
    interactionId = await resolveEventQa(getDb(), id);
  }
  return Response.json({
    interactionId,
    questions: interactionId ? await listHostQuestions(interactionId) : [],
    notes: await listHostNotes(id),
  });
}
