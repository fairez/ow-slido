import { and, count, eq, gte, lt } from "drizzle-orm";
import { aiCalls, events, participants } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { MessageKey } from "@/lib/i18n/en";
import { serverT } from "@/lib/i18n/server";
import { PLAN_IDS, PLANS, getEntitlements, utcMonthBounds, type GatedInteractionType, type PlanId, type ReportFormat } from "@/lib/plans";

type Db = Pick<ReturnType<typeof getDb>, "select">;

export type LimitReason =
  | "type_not_allowed"
  | "event_limit"
  | "seat_limit"
  | "participant_limit"
  | "ai_event_limit"
  | "ai_month_limit"
  | "report_format";

/** A server-enforced plan limit. Routes answer 402 `{error, reason, requiredPlan}` via `planLimitResponse`. */
export class PlanLimitError extends Error {
  constructor(
    readonly reason: LimitReason,
    readonly messageKey: MessageKey,
    /** Cheapest plan that would allow the request; null when no plan does. */
    readonly requiredPlan: PlanId | null,
    readonly params: Record<string, string | number> = {},
  ) {
    super(messageKey);
  }
}

export function planLimitResponse(request: Request, error: PlanLimitError) {
  return Response.json(
    { error: serverT(request, error.messageKey, error.params), reason: error.reason, requiredPlan: error.requiredPlan },
    { status: 402 },
  );
}

function cheapestPlan(allows: (plan: PlanId) => boolean): PlanId | null {
  return PLAN_IDS.find(allows) ?? null;
}

export async function assertTypeAllowed(workspaceId: string, type: GatedInteractionType, db: Db = getDb()) {
  const { limits, plan } = await getEntitlements(workspaceId, { db });
  if (limits.allowedTypes.includes(type)) return;
  const requiredPlan = cheapestPlan((p) => PLANS[p].allowedTypes.includes(type));
  throw new PlanLimitError("type_not_allowed", "api.planTypeNotAllowed", requiredPlan, { type, plan });
}

/** Events created this UTC month count, whether or not they were deleted since is not tracked. */
export async function assertCanCreateEvent(workspaceId: string, db: Db = getDb(), now: Date = new Date()) {
  const { limits } = await getEntitlements(workspaceId, { db, now });
  if (limits.eventsPerMonth === null) return;
  const { start, end } = utcMonthBounds(now);
  const [{ used }] = await db
    .select({ used: count() })
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, start), lt(events.createdAt, end)));
  if (used < limits.eventsPerMonth) return;
  const requiredPlan = cheapestPlan((p) => {
    const max = PLANS[p].eventsPerMonth;
    return max === null || used < max;
  });
  throw new PlanLimitError("event_limit", "api.planEventLimit", requiredPlan, { limit: limits.eventsPerMonth });
}

/**
 * Call inside a transaction that holds a per-event lock, so two joins cannot both take the last slot.
 * A participant who already has a row never reaches this: the join route only asks for a new one.
 */
export async function assertParticipantSlot(workspaceId: string, eventId: string, db: Db = getDb()) {
  const { limits } = await getEntitlements(workspaceId, { db });
  const [{ used }] = await db.select({ used: count() }).from(participants).where(eq(participants.eventId, eventId));
  if (used < limits.participantsPerEvent) return;
  const requiredPlan = cheapestPlan((p) => used < PLANS[p].participantsPerEvent);
  throw new PlanLimitError("participant_limit", "api.participantLimit", requiredPlan, { limit: limits.participantsPerEvent });
}

/**
 * Checks the tier's AI budget before an analysis starts, on top of the env caps in `reserveAiCall`.
 * Calls of deleted events are not counted: `ai_calls.event_id` is set to null when an event goes.
 */
export async function assertAiCallsAvailable(workspaceId: string, eventId: string, db: Db = getDb(), now: Date = new Date()) {
  const { limits, plan } = await getEntitlements(workspaceId, { db, now });
  if (limits.aiCallsPerEvent === 0 || limits.aiCallsPerMonth === 0) {
    const requiredPlan = cheapestPlan((p) => PLANS[p].aiCallsPerEvent > 0 && PLANS[p].aiCallsPerMonth > 0);
    throw new PlanLimitError("ai_event_limit", "api.planAiNotIncluded", requiredPlan, { plan });
  }

  const [{ forEvent }] = await db.select({ forEvent: count() }).from(aiCalls).where(eq(aiCalls.eventId, eventId));
  if (forEvent >= limits.aiCallsPerEvent) {
    const requiredPlan = cheapestPlan((p) => forEvent < PLANS[p].aiCallsPerEvent);
    throw new PlanLimitError("ai_event_limit", "api.planAiEventLimit", requiredPlan, { limit: limits.aiCallsPerEvent });
  }

  const { start, end } = utcMonthBounds(now);
  const [{ forMonth }] = await db
    .select({ forMonth: count() })
    .from(aiCalls)
    .innerJoin(events, eq(events.id, aiCalls.eventId))
    .where(and(eq(events.workspaceId, workspaceId), gte(aiCalls.createdAt, start), lt(aiCalls.createdAt, end)));
  if (forMonth >= limits.aiCallsPerMonth) {
    const requiredPlan = cheapestPlan((p) => forMonth < PLANS[p].aiCallsPerMonth);
    throw new PlanLimitError("ai_month_limit", "api.planAiMonthLimit", requiredPlan, { limit: limits.aiCallsPerMonth });
  }
}

export async function assertReportFormat(workspaceId: string, format: ReportFormat, db: Db = getDb()) {
  const { limits } = await getEntitlements(workspaceId, { db });
  if (limits.reportFormats.includes(format)) return;
  const requiredPlan = cheapestPlan((p) => PLANS[p].reportFormats.includes(format));
  throw new PlanLimitError("report_format", "api.planReportFormat", requiredPlan, { format });
}
