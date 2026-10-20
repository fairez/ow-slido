import { serverT } from "@/lib/i18n/server";
import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { findOwnedEvent } from "@/lib/polls";
import { listApprovedQuestions, resolveEventQa } from "@/lib/questions";

/** Approved questions of the live (else first) Q&A for the owner's presenter screen (resync after a reconnect). Never pending or rejected ones. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMember(request, "results.view");
  if (!auth.ok) return auth.response;
  const event = await findOwnedEvent((await params).id, auth.workspaceId);
  if (!event) return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });
  const interactionId = await resolveEventQa(getDb(), event.id);
  return Response.json({
    interactionId,
    questions: interactionId ? await listApprovedQuestions(interactionId) : [],
  });
}
