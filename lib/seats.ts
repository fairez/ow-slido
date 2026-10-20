import { and, count, eq, gt, ne } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { invitations, memberships } from "@/db/schema";
import { getDb } from "@/lib/db";
import { PlanLimitError } from "@/lib/limits";
import { PLAN_IDS, PLANS, getEntitlements } from "@/lib/plans";

/** Reads only, so a transaction works as well as the pool. */
type Db = Pick<ReturnType<typeof createDb>["db"], "select">;

/** A seat is an active membership or a pending invitation that has not expired. Suspended members hold none. */
export async function seatsInUse(workspaceId: string, options: { db?: Db; exceptInvitationId?: string } = {}) {
  const db = options.db ?? getDb();
  const [{ members }] = await db
    .select({ members: count() })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, "active")));
  const [{ pending }] = await db
    .select({ pending: count() })
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
        options.exceptInvitationId ? ne(invitations.id, options.exceptInvitationId) : undefined,
      ),
    );
  return members + pending;
}

/**
 * Throws `PlanLimitError` (reason `seat_limit`) when one more seat would pass the plan's limit. Called before
 * an invitation is created, before one is accepted (pass that invitation as `exceptInvitationId`, since it
 * already holds its seat) and before a suspended member is reactivated.
 */
export async function assertSeatAvailable(workspaceId: string, options: { db?: Db; exceptInvitationId?: string } = {}) {
  const db = options.db ?? getDb();
  const { limits } = await getEntitlements(workspaceId, { db });
  const used = await seatsInUse(workspaceId, options);
  if (used < limits.seats) return;
  const requiredPlan = PLAN_IDS.find((p) => PLANS[p].seats > used) ?? null;
  throw new PlanLimitError("seat_limit", "api.planSeatLimit", requiredPlan, { limit: limits.seats });
}
