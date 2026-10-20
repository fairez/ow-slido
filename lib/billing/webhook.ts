import { eq } from "drizzle-orm";
import { billingEvents, subscriptions, workspaces } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { BillingEvent, BillingProvider } from "./types";

type Db = ReturnType<typeof getDb>;

export type WebhookResult = "applied" | "duplicate" | "ignored";

/**
 * Stores the event and updates the workspace's subscription in one transaction, so a failure leaves
 * nothing behind and the provider's retry applies it. A redelivered id hits the unique key and does nothing.
 * Plan overrides are left alone: they win over the paid plan in `resolveEntitlements`.
 */
export async function applyBillingEvent(provider: string, event: BillingEvent, db: Db = getDb()): Promise<WebhookResult> {
  return db.transaction(async (tx) => {
    const [workspace] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, event.workspaceId));
    if (!workspace) return "ignored";

    const inserted = await tx
      .insert(billingEvents)
      .values({ provider, providerEventId: event.id, workspaceId: event.workspaceId, type: event.type })
      .onConflictDoNothing()
      .returning({ id: billingEvents.id });
    if (inserted.length === 0) return "duplicate";

    const state = {
      plan: event.plan,
      status: event.status,
      interval: event.interval,
      currentPeriodEnd: event.currentPeriodEnd,
      provider,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
      updatedAt: new Date(),
    };
    await tx
      .insert(subscriptions)
      .values({ workspaceId: event.workspaceId, ...state })
      .onConflictDoUpdate({ target: subscriptions.workspaceId, set: state });
    return "applied";
  });
}

/** Verify, then apply. Everything that changes a subscription from a provider goes through here. */
export async function receiveWebhook(
  provider: BillingProvider,
  rawBody: string,
  headers: Headers,
  db: Db = getDb(),
): Promise<WebhookResult> {
  const event = await provider.parseWebhook(rawBody, headers);
  if (!event) return "ignored";
  return applyBillingEvent(provider.id, event, db);
}
