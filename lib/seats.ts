import { and, asc, count, eq, gt, inArray, ne } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { invitations, memberships } from "@/db/schema";
import { getDb } from "@/lib/db";
import { PlanLimitError } from "@/lib/limits";
import { PLAN_IDS, PLANS, getEntitlements } from "@/lib/plans";
import { revokeMemberSockets } from "@/lib/realtime/publisher";

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

export type SeatReconciliation = { suspended: string[]; reactivated: string[] };

/**
 * Brings active members in line with the plan's seats, after a downgrade or an upgrade or when a seat frees up.
 * - Too many active members: the newest are suspended with reason `seat_limit` until the count fits. The last
 *   active owner is never suspended, so the workspace can stay over its limit when only owners are left.
 * - Seats to spare: members suspended for `seat_limit` (never the manually suspended) come back, oldest first,
 *   while active members plus pending invitations stay within the limit.
 * Their live host sockets are dropped like any other suspension. Safe to call at any time; it only acts on a mismatch.
 */
export async function reconcileSeats(workspaceId: string, options: { db?: ReturnType<typeof getDb>; now?: Date } = {}): Promise<SeatReconciliation> {
  const db = options.db ?? getDb();
  const result = await db.transaction(async (tx) => {
    // Same lock as the member rules take, so this cannot race a role change that makes someone the last owner.
    const rows = await tx
      .select({ userId: memberships.userId, role: memberships.role, status: memberships.status, reason: memberships.suspendedReason })
      .from(memberships)
      .where(eq(memberships.workspaceId, workspaceId))
      .orderBy(asc(memberships.createdAt), asc(memberships.userId))
      .for("update");
    const { limits } = await getEntitlements(workspaceId, { db: tx, now: options.now });
    const active = rows.filter((row) => row.status === "active");
    const outcome: SeatReconciliation = { suspended: [], reactivated: [] };

    let excess = active.length - limits.seats;
    if (excess > 0) {
      let owners = active.filter((row) => row.role === "owner").length;
      for (const row of [...active].reverse()) {
        if (excess === 0) break;
        if (row.role === "owner") {
          if (owners === 1) continue;
          owners -= 1;
        }
        outcome.suspended.push(row.userId);
        excess -= 1;
      }
    } else {
      let room = limits.seats - (await seatsInUse(workspaceId, { db: tx }));
      for (const row of rows) {
        if (room <= 0) break;
        if (row.status === "suspended" && row.reason === "seat_limit") {
          outcome.reactivated.push(row.userId);
          room -= 1;
        }
      }
    }

    if (outcome.suspended.length > 0) {
      await tx
        .update(memberships)
        .set({ status: "suspended", suspendedReason: "seat_limit" })
        .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, outcome.suspended)));
    }
    if (outcome.reactivated.length > 0) {
      await tx
        .update(memberships)
        .set({ status: "active", suspendedReason: null })
        .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, outcome.reactivated)));
    }
    return outcome;
  });
  for (const userId of result.suspended) revokeMemberSockets(userId, workspaceId);
  return result;
}
