import { serverT, apiMessage } from "@/lib/i18n/server";
import { requireMember } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { PlanLimitError, assertAiCallsAvailable, planLimitResponse } from "@/lib/limits";
import { findNotesInteractionEvent, startAnalysis } from "@/lib/note-analysis";
import "@/lib/note-analysis-ai";
import { findOwnedEvent } from "@/lib/polls";
import { getDb } from "@/lib/db";
import { events } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireMember(request, "insights.manage");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const interaction = isUuid(id) ? await findNotesInteractionEvent(id) : null;
  const event = interaction ? await findOwnedEvent(interaction.eventId, auth.workspaceId) : null;
  if (!interaction || !event) return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });

  try {
    await assertAiCallsAvailable(auth.workspaceId, event.id);
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }

  if (!event.aiNoticeAcceptedAt) {
    const body = (await request.json().catch(() => null)) as { acceptNotice?: unknown } | null;
    if (body?.acceptNotice !== true) {
      return Response.json(
        { error: serverT(request, "api.aiNoticeRequired"), code: "notice_required" },
        { status: 409 },
      );
    }
    await getDb()
      .update(events)
      .set({ aiNoticeAcceptedAt: new Date() })
      .where(and(eq(events.id, event.id), isNull(events.aiNoticeAcceptedAt)));
  }

  const result = await startAnalysis(event.id, id);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  return Response.json({ analysis: result.analysis }, { status: 202 });
}
