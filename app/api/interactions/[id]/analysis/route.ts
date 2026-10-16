import { requireAdmin } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { parseEdit } from "@/lib/analysis-edit";
import { editAnalysis, findNotesInteractionEvent, getAnalysisPanelState, setAnalysisPublished } from "@/lib/note-analysis";
import { findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const interaction = isUuid(id) ? await findNotesInteractionEvent(id) : null;
  const event = interaction ? await findOwnedEvent(interaction.eventId, auth.user.id) : null;
  if (!interaction || !event) return Response.json({ error: "Interaction not found" }, { status: 404 });

  const state = await getAnalysisPanelState(id);
  return Response.json({
    analysis: state.latest,
    lastDone: state.lastDone,
    approvedNoteCount: state.approvedNoteCount,
    notes: state.notes,
    noticeAccepted: event.aiNoticeAcceptedAt !== null,
  });
}

/** Publish or unpublish the latest finished analysis, or apply a host edit (`{op, ...}`) to it. */
export async function PATCH(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const interaction = isUuid(id) ? await findNotesInteractionEvent(id) : null;
  const event = interaction ? await findOwnedEvent(interaction.eventId, auth.user.id) : null;
  if (!interaction || !event) return Response.json({ error: "Interaction not found" }, { status: 404 });

  const raw = await request.json().catch(() => null);
  if (typeof raw === "object" && raw !== null && "op" in raw) {
    const edit = parseEdit(raw);
    if (!edit.ok) return Response.json({ error: edit.error }, { status: 400 });
    const outcome = await editAnalysis(id, edit.value);
    if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
    return Response.json({ analysis: outcome.analysis });
  }
  const body = raw as { published?: unknown } | null;
  if (typeof body?.published !== "boolean") return Response.json({ error: "published must be true or false" }, { status: 400 });
  const analysis = await setAnalysisPublished(id, body.published);
  if (!analysis) return Response.json({ error: "There is no finished analysis to publish" }, { status: 409 });
  return Response.json({ analysis });
}
