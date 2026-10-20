import { and, asc, eq, gte, lt } from "drizzle-orm";
import { events } from "@/db/schema";
import { getDb } from "@/lib/db";
import { PlanLimitError } from "@/lib/limits";
import { PLAN_IDS, PLANS, cheapestPlan, getEntitlements, utcMonthBounds, type GatedInteractionType, type PlanId } from "@/lib/plans";

type Db = Pick<ReturnType<typeof getDb>, "select">;

/**
 * Content a downgrade left behind: it stays visible, with results and CSV export, but cannot be started,
 * edited or duplicated. Nothing is stored; every answer comes from the current entitlements, so an
 * upgrade unlocks it again without a job. `requiredPlan` is the cheapest tier that would unlock it.
 */
export type OverLimit = { requiredPlan: PlanId | null };

const rankOf = (plan: PlanId | null) => (plan === null ? PLAN_IDS.length : PLAN_IDS.indexOf(plan));

/** Both reasons must be lifted, so the dearer tier is the one that unlocks. */
export function combineOverLimit(a: OverLimit | null, b: OverLimit | null): OverLimit | null {
  if (!a || !b) return a ?? b;
  return { requiredPlan: rankOf(a.requiredPlan) >= rankOf(b.requiredPlan) ? a.requiredPlan : b.requiredPlan };
}

/**
 * Events created this UTC month past the plan's monthly cap, oldest kept: the cap lets the first N through,
 * so only a downgrade can leave later ones over it. Older months are not counted, as in `assertCanCreateEvent`.
 */
export async function overLimitEvents(workspaceId: string, db: Db = getDb(), now: Date = new Date()): Promise<Map<string, OverLimit>> {
  const { limits } = await getEntitlements(workspaceId, { db, now });
  const locks = new Map<string, OverLimit>();
  const cap = limits.eventsPerMonth;
  if (cap === null) return locks;
  const { start, end } = utcMonthBounds(now);
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, start), lt(events.createdAt, end)))
    .orderBy(asc(events.createdAt), asc(events.id));
  rows.forEach((row, index) => {
    if (index < cap) return;
    const rank = index + 1;
    locks.set(row.id, { requiredPlan: cheapestPlan((p) => PLANS[p].eventsPerMonth === null || rank <= (PLANS[p].eventsPerMonth ?? 0)) });
  });
  return locks;
}

/** Set when the plan no longer includes this interaction type. */
export async function typeOverLimit(workspaceId: string, type: GatedInteractionType, db: Db = getDb(), now: Date = new Date()): Promise<OverLimit | null> {
  const { limits } = await getEntitlements(workspaceId, { db, now });
  if (limits.allowedTypes.includes(type)) return null;
  return { requiredPlan: cheapestPlan((p) => PLANS[p].allowedTypes.includes(type)) };
}

/**
 * Throws `PlanLimitError` (reason `over_limit`, answered 403) when the event is past the monthly cap or,
 * if `type` is given, the interaction's type is not in the plan. Call it before starting, editing or duplicating.
 */
export async function assertNotOverLimit(
  workspaceId: string,
  target: { eventId: string; type?: GatedInteractionType },
  db: Db = getDb(),
  now: Date = new Date(),
) {
  const byEvent = (await overLimitEvents(workspaceId, db, now)).get(target.eventId) ?? null;
  const byType = target.type ? await typeOverLimit(workspaceId, target.type, db, now) : null;
  const lock = combineOverLimit(byEvent, byType);
  if (lock) throw new PlanLimitError("over_limit", "api.overLimit", lock.requiredPlan);
}
