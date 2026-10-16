import { requireAdmin } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { findNotesInteractionEvent, getLatestAnalysis } from "@/lib/note-analysis";
import { findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const interaction = isUuid(id) ? await findNotesInteractionEvent(id) : null;
  const event = interaction ? await findOwnedEvent(interaction.eventId, auth.user.id) : null;
  if (!interaction || !event) return Response.json({ error: "Interaction not found" }, { status: 404 });

  return Response.json({ analysis: await getLatestAnalysis(id) });
}
