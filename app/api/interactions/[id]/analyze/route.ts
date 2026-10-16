import { requireAdmin } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { findNotesInteractionEvent, startAnalysis } from "@/lib/note-analysis";
import "@/lib/note-analysis-ai";
import { findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const interaction = isUuid(id) ? await findNotesInteractionEvent(id) : null;
  const event = interaction ? await findOwnedEvent(interaction.eventId, auth.user.id) : null;
  if (!interaction || !event) return Response.json({ error: "Interaction not found" }, { status: 404 });

  const result = await startAnalysis(event.id, id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ analysis: result.analysis }, { status: 202 });
}
