import { authorizeModeration } from "@/lib/auth/require-moderation";
import { isUuid } from "@/lib/events";
import { listHostNotes, listHostQuestions } from "@/lib/moderation";

/** Host or moderator: pending and approved questions and notes of the event. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await authorizeModeration(request, id);
  if (denied) return denied;
  if (!isUuid(id)) return Response.json({ error: "Event not found" }, { status: 404 });
  return Response.json({ questions: await listHostQuestions(id), notes: await listHostNotes(id) });
}
