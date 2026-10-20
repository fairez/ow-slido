import { and, eq, ne } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { deletedWorkspaces, memberships, subscriptions, users, workspaces } from "@/db/schema";
import { getBillingProvider, BillingNotConfiguredError } from "@/lib/billing";
import { getEntitlements, type PlanId } from "@/lib/plans";
import { revokeMemberSockets } from "@/lib/realtime/publisher";
import { createPersonalWorkspace } from "@/lib/workspaces";
import type { MessageKey } from "@/lib/i18n/en";

type Db = ReturnType<typeof createDb>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type DeleteFailure = { ok: false; error: MessageKey; status: number; reason?: string };

/**
 * Stops the provider subscription of a workspace that is about to go, so nobody keeps paying for it.
 * Free workspaces and subscriptions the provider already ended need no call, so they work without billing set up.
 * Throws `BillingNotConfiguredError` when the subscription belongs to a provider that is not active here and
 * `BillingProviderError` when the provider refuses; the caller must then leave the workspace alone.
 * Returns whether the provider was asked.
 */
export async function cancelWorkspaceSubscription(db: Pick<Db, "select">, workspaceId: string): Promise<boolean> {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
  if (
    !row ||
    row.plan === "free" ||
    row.status === "canceled" ||
    !row.providerSubscriptionId ||
    !row.providerCustomerId ||
    !row.currentPeriodEnd
  ) {
    return false;
  }
  const provider = getBillingProvider();
  if (row.provider !== provider.id) {
    throw new BillingNotConfiguredError(`The subscription belongs to ${row.provider ?? "another provider"}`);
  }
  await provider.cancelSubscription({
    workspaceId,
    providerSubscriptionId: row.providerSubscriptionId,
    providerCustomerId: row.providerCustomerId,
    plan: row.plan,
    interval: row.interval,
    currentPeriodEnd: row.currentPeriodEnd,
  });
  return true;
}

/**
 * Inside a transaction: writes the content-free record and deletes the workspace row, which removes every table
 * below it by cascade. A former member left without any active workspace gets a personal one, so they can still sign
 * in to a dashboard; `skipUserId` (an account being deleted) never does. Returns the members who lost access.
 */
export async function removeWorkspaceRows(tx: Tx, workspaceId: string, plan: PlanId, skipUserId?: string) {
  const members = await tx
    .select({ userId: memberships.userId, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId));
  await tx.insert(deletedWorkspaces).values({ id: workspaceId, plan }).onConflictDoNothing();
  await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
  for (const member of members) {
    if (member.userId === skipUserId) continue;
    const [home] = await tx
      .select({ workspaceId: memberships.workspaceId })
      .from(memberships)
      .where(and(eq(memberships.userId, member.userId), eq(memberships.status, "active"), ne(memberships.workspaceId, workspaceId)))
      .limit(1);
    if (!home) await createPersonalWorkspace(tx, { id: member.userId, email: member.email });
  }
  return members.map((m) => m.userId);
}

/**
 * Deletes a workspace and everything in it. The subscription is cancelled first and a refusal stops everything
 * (nothing is deleted while a payment could still be taken). Then one transaction removes the data by cascade and
 * keeps a `deleted_workspaces` row (id, time, plan), and live host sockets of every member drop.
 */
export async function deleteWorkspace(db: Db, workspaceId: string): Promise<{ ok: true; plan: PlanId } | DeleteFailure> {
  const [workspace] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) return { ok: false, error: "api.forbidden", status: 403 };

  const { plan } = await getEntitlements(workspaceId, { db });
  await cancelWorkspaceSubscription(db, workspaceId);

  const memberIds = await db.transaction((tx) => removeWorkspaceRows(tx, workspaceId, plan));
  for (const userId of memberIds) revokeMemberSockets(userId, workspaceId);
  return { ok: true, plan };
}
