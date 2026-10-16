import { requireAdmin } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { findNotesInteractionEvent, startAnalysis } from "@/lib/note-analysis";
import "@/lib/note-analysis-ai";
import { findOwnedEvent } from "@/lib/polls";
import { getDb } from "@/lib/db";
import { events } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const interaction = isUuid(id) ? await findNotesInteractionEvent(id) : null;
  const event = interaction ? await findOwnedEvent(interaction.eventId, auth.user.id) : null;
  if (!interaction || !event) return Response.json({ error: "Interaction not found" }, { status: 404 });

  if (!event.aiNoticeAcceptedAt) {
    const body = (await request.json().catch(() => null)) as { acceptNotice?: unknown } | null;
    if (body?.acceptNotice !== true) {
      return Response.json(
        { error: "Accept the AI notice before the first analysis", code: "notice_required" },
        { status: 409 },
      );
    }
    await getDb()
      .update(events)
      .set({ aiNoticeAcceptedAt: new Date() })
      .where(and(eq(events.id, event.id), isNull(events.aiNoticeAcceptedAt)));
  }

  const result = await startAnalysis(event.id, id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ analysis: result.analysis }, { status: 202 });
}
