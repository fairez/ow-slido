import { and, count, eq, gte, lt } from "drizzle-orm";
import { events } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { MessageKey } from "@/lib/i18n/en";
import { serverT } from "@/lib/i18n/server";
import { PLAN_IDS, PLANS, getEntitlements, utcMonthBounds, type GatedInteractionType, type PlanId } from "@/lib/plans";

type Db = Pick<ReturnType<typeof getDb>, "select">;

export type LimitReason = "type_not_allowed" | "event_limit" | "seat_limit";

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
