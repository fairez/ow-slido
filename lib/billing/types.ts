import type { subscriptions } from "@/db/schema";
import type { BillingInterval, PlanId } from "@/lib/plans";

export type PaidPlan = Exclude<PlanId, "free">;
export type SubscriptionStatus = (typeof subscriptions.$inferSelect)["status"];

/** A provider event reduced to what we store. Only verified events become one; see `parseWebhook`. */
export type BillingEvent = {
  /** The provider's own event id; with the provider name it is the idempotency key. */
  id: string;
  /** Provider event name, kept for the audit row only. */
  type: string;
  workspaceId: string;
  plan: PaidPlan;
  interval: BillingInterval;
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  providerCustomerId: string;
  providerSubscriptionId: string;
};

export type CheckoutInput = {
  workspaceId: string;
  plan: PaidPlan;
  interval: BillingInterval;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
};

export type CancelInput = {
  workspaceId: string;
  providerSubscriptionId: string;
  plan: PaidPlan;
  interval: BillingInterval;
  currentPeriodEnd: Date;
  providerCustomerId: string;
};

export interface BillingProvider {
  /** Stored in `subscriptions.provider` and `billing_events.provider`. */
  readonly id: string;
  createCheckout(input: CheckoutInput): Promise<{ url: string }>;
  createPortalSession(input: { workspaceId: string; providerCustomerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Ends renewal; paid access lasts until the period end. State changes only when the provider's webhook arrives. */
  cancelSubscription(input: CancelInput): Promise<void>;
  /**
   * Verifies the signature over the raw body and returns the event, or null for event kinds we do not act on.
   * Throws `BillingSignatureError` for a bad signature and `BillingPayloadError` for a body we cannot read.
   */
  parseWebhook(rawBody: string, headers: Headers): Promise<BillingEvent | null>;
}

export class BillingSignatureError extends Error {}
export class BillingPayloadError extends Error {}
export class BillingNotConfiguredError extends Error {}
/** Stripe (or another provider) answered a request with an error; the message has no secrets in it. */
export class BillingProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
