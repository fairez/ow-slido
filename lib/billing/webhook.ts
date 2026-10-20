import { eq } from "drizzle-orm";
import { billingEvents, subscriptions, workspaces } from "@/db/schema";
import { getDb } from "@/lib/db";
import { reconcileSeats } from "@/lib/seats";
import type { BillingEvent, BillingProvider } from "./types";

type Db = ReturnType<typeof getDb>;

export type WebhookResult = "applied" | "duplicate" | "ignored";

/**
 * Stores the event and updates the workspace's subscription in one transaction, so a failure leaves
 * nothing behind and the provider's retry applies it. A redelivered id hits the unique key and does nothing.
 * Plan overrides are left alone: they win over the paid plan in `resolveEntitlements`.
 */
export async function applyBillingEvent(
  provider: string,
  event: BillingEvent,
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<WebhookResult> {
  const result = await db.transaction(async (tx) => {
    const [workspace] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, event.workspaceId));
    if (!workspace) return "ignored";

    const inserted = await tx
      .insert(billingEvents)
      .values({ provider, providerEventId: event.id, workspaceId: event.workspaceId, type: event.type })
      .onConflictDoNothing()
      .returning({ id: billingEvents.id });
    if (inserted.length === 0) return "duplicate";

    // The grace clock starts when the subscription first turns past_due and stops with any other status.
    const [existing] = await tx
      .select({ pastDueSince: subscriptions.pastDueSince })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, event.workspaceId))
      .for("update");
    const pastDueSince = event.status === "past_due" ? (existing?.pastDueSince ?? now) : null;

    const state = {
      plan: event.plan,
      status: event.status,
      interval: event.interval,
      currentPeriodEnd: event.currentPeriodEnd,
      pastDueSince,
      provider,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
      updatedAt: now,
    };
    await tx
      .insert(subscriptions)
      .values({ workspaceId: event.workspaceId, ...state })
      .onConflictDoUpdate({ target: subscriptions.workspaceId, set: state });
    return "applied" as const;
  });
  // A plan change can leave members without a seat, or give suspended ones theirs back. The event is stored
  // by now, so a failure here must not make the provider retry; the daily sweep and the members page repeat it.
  if (result === "applied") {
    await reconcileSeats(event.workspaceId, { db, now }).catch((error) =>
      console.error("> seat reconcile failed:", error instanceof Error ? error.message : error),
    );
  }
  return result;
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
