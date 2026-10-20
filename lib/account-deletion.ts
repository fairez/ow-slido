import { eq, inArray } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { memberships, users, workspaces } from "@/db/schema";
import { getEntitlements, type PlanId } from "@/lib/plans";
import { revokeMemberSockets } from "@/lib/realtime/publisher";
import { reconcileSeats } from "@/lib/seats";
import { cancelWorkspaceSubscription, removeWorkspaceRows, type DeleteFailure, type Tx } from "@/lib/workspace-deletion";

type Db = ReturnType<typeof createDb>["db"];

type Row = { userId: string; role: string; status: string };

/**
 * What deleting an account means for one workspace the person belongs to:
 * - `delete`: they are its only member, so nobody could reach it afterwards and it goes with them;
 * - `blocked`: they are the last active owner and others remain, so ownership must move or the workspace go first;
 * - `leave`: only the membership ends; events and everything else stay with the workspace.
 */
export function accountDeletionOutcome(rows: Row[], userId: string): "delete" | "blocked" | "leave" {
  const mine = rows.find((r) => r.userId === userId);
  if (!mine) return "leave";
  const others = rows.filter((r) => r.userId !== userId);
  if (others.length === 0) return "delete";
  if (mine.role !== "owner" || mine.status !== "active") return "leave";
  return others.some((r) => r.role === "owner" && r.status === "active") ? "leave" : "blocked";
}

async function membersOf(db: Pick<Db, "select">, workspaceIds: string[]) {
  const rows = workspaceIds.length
    ? await db
        .select({ workspaceId: memberships.workspaceId, userId: memberships.userId, role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(inArray(memberships.workspaceId, workspaceIds))
    : [];
  const byWorkspace = new Map<string, Row[]>(workspaceIds.map((id) => [id, []]));
  for (const row of rows) byWorkspace.get(row.workspaceId)?.push(row);
  return byWorkspace;
}

function classify(byWorkspace: Map<string, Row[]>, userId: string) {
  const out = { blocked: [] as string[], solo: [] as string[], left: [] as string[] };
  for (const [workspaceId, rows] of byWorkspace) {
    const outcome = accountDeletionOutcome(rows, userId);
    (outcome === "blocked" ? out.blocked : outcome === "delete" ? out.solo : out.left).push(workspaceId);
  }
  return out;
}

class Blocked extends Error {
  constructor(readonly workspaceIds: string[]) {
    super("sole_owner");
  }
}

export type AccountDeletion =
  | { ok: true; leftWorkspaceIds: string[]; deletedWorkspaceIds: string[] }
  | (DeleteFailure & { workspaces?: { id: string; name: string }[] });

async function blockedFailure(db: Pick<Db, "select">, workspaceIds: string[]): Promise<AccountDeletion> {
  const named = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, workspaceIds));
  return { ok: false, error: "api.accountSoleOwner", status: 409, reason: "sole_owner", workspaces: named };
}

/**
 * Deletes a person's account. Checked first, outside the transaction: a workspace where they are the last active
 * owner of other people blocks it (409 `sole_owner`, nothing changes). Workspaces where they are the only member
 * are deleted with the account, their subscriptions cancelled beforehand; a provider failure throws and stops the
 * whole thing. Then one transaction re-checks the same rule with the membership rows locked, deletes those
 * workspaces and the user, and the cascade ends every membership. Events the person created stay: `events.owner_id`
 * is set null. Everything else they made (templates, invitations, exports) already keeps its row without the id.
 */
export async function deleteAccount(db: Db, userId: string): Promise<AccountDeletion> {
  const mine = await db.select({ workspaceId: memberships.workspaceId }).from(memberships).where(eq(memberships.userId, userId));
  const ids = mine.map((m) => m.workspaceId);

  const first = classify(await membersOf(db, ids), userId);
  if (first.blocked.length > 0) return blockedFailure(db, first.blocked);

  const plans = new Map<string, PlanId>();
  for (const workspaceId of first.solo) {
    plans.set(workspaceId, (await getEntitlements(workspaceId, { db })).plan);
    await cancelWorkspaceSubscription(db, workspaceId);
  }

  let result: { left: string[]; deleted: string[] };
  try {
    result = await db.transaction(async (tx: Tx) => {
      // Locking the person's own rows makes a concurrent role change or member removal wait for this decision.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
      if (ids.length > 0) {
        await tx.select({ id: memberships.userId }).from(memberships).where(inArray(memberships.workspaceId, ids)).for("update");
      }
      const again = classify(await membersOf(tx, ids), userId);
      if (again.blocked.length > 0) throw new Blocked(again.blocked);
      for (const workspaceId of again.solo) {
        await removeWorkspaceRows(tx, workspaceId, plans.get(workspaceId) ?? "free", userId);
      }
      await tx.delete(users).where(eq(users.id, userId));
      return { left: again.left, deleted: again.solo };
    });
  } catch (error) {
    if (error instanceof Blocked) return blockedFailure(db, error.workspaceIds);
    throw error;
  }

  for (const workspaceId of ids) revokeMemberSockets(userId, workspaceId);
  // Their seat is free again, which may bring back someone the plan had suspended.
  for (const workspaceId of result.left) await reconcileSeats(workspaceId, { db });
  return { ok: true, leftWorkspaceIds: result.left, deletedWorkspaceIds: result.deleted };
}
