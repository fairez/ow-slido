import { requireAdmin } from "@/lib/auth/require-admin";
import { findOwnedEvent } from "@/lib/polls";
import { listApprovedQuestions } from "@/lib/questions";

/** Approved questions for the owner's presenter screen (resync after a reconnect). Never pending or rejected ones. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const event = await findOwnedEvent((await params).id, auth.user.id);
  if (!event) return Response.json({ error: "Event not found" }, { status: 404 });
  return Response.json({ questions: await listApprovedQuestions(event.id) });
}
