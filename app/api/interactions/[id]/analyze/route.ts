import { serverT, apiMessage } from "@/lib/i18n/server";
import { requireMember } from "@/lib/auth/require-admin";
import { isUuid } from "@/lib/events";
import { AiPausedError, assertAiNotPaused } from "@/lib/ai/usage";
import { workspaceRateLimited } from "@/lib/workspace-rate-limit";
import { PlanLimitError, assertAiCallsAvailable, planLimitResponse } from "@/lib/limits";
import { findNotesInteractionEvent, startAnalysis } from "@/lib/note-analysis";
import "@/lib/note-analysis-ai";
import { findOwnedEvent } from "@/lib/polls";
import { auditContext, recordAudit } from "@/lib/audit";
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
    await assertAiNotPaused();
    await assertAiCallsAvailable(auth.workspaceId, event.id);
  } catch (error) {
    if (error instanceof AiPausedError) {
      return Response.json({ error: serverT(request, "api.aiPaused"), reason: "ai_paused" }, { status: 503 });
    }
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
    await recordAudit(undefined, {
      ...auditContext(request, auth.user),
      workspaceId: auth.workspaceId,
      action: "ai.notice_accepted",
      targetType: "event",
      targetId: event.id,
    });
  }

  const limited = await workspaceRateLimited(request, auth.workspaceId, "ai");
  if (limited) return limited;

  const result = await startAnalysis(event.id, id);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: result.status });
  await recordAudit(undefined, {
    ...auditContext(request, auth.user),
    workspaceId: auth.workspaceId,
    action: "ai.analysis_started",
    targetType: "interaction",
    targetId: id,
    metadata: { eventId: event.id },
  });
  return Response.json({ analysis: result.analysis }, { status: 202 });
}
