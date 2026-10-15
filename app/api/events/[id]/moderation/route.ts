import { requireAdmin } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { listHostQuestions } from "@/lib/moderation";
import { findOwnedEvent } from "@/lib/polls";

/** Host-only: pending and approved questions of the event. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!isUuid(id) || !(await findOwnedEvent(id, auth.user.id))) {
    return Response.json({ error: "Event not found" }, { status: 404 });
  }
  return Response.json({ questions: await listHostQuestions(id) });
}
