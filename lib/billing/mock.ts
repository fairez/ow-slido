import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { BillingInterval } from "@/lib/plans";
import {
  BillingNotConfiguredError,
  BillingPayloadError,
  BillingSignatureError,
  type BillingEvent,
  type BillingProvider,
  type CancelInput,
  type CheckoutInput,
  type PaidPlan,
} from "./types";
import { receiveWebhook } from "./webhook";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";
const CHECKOUT_TTL_MS = 30 * 60_000;
const DEV_SECRET = "mock-billing-secret-for-local-use-only";

/** Production has no fallback: a public default would let anyone forge webhooks. */
function secret(): string {
  const configured = process.env.BILLING_WEBHOOK_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") throw new BillingNotConfiguredError("BILLING_WEBHOOK_SECRET is required for the mock billing provider");
  return DEV_SECRET;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

function matches(payload: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(sign(payload), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type CheckoutClaims = { workspaceId: string; plan: PaidPlan; interval: BillingInterval; nonce: string; expires: number };

function addPeriod(from: Date, interval: BillingInterval): Date {
  const end = new Date(from);
  if (interval === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

/**
 * Stands in for a payment provider in dev, tests and e2e. "Checkout" is a signed link to a local
 * route; its state changes arrive as HMAC-signed webhooks through the same path a real provider uses.
 */
export class MockBillingProvider implements BillingProvider {
  readonly id = "mock";

  async createCheckout(input: CheckoutInput) {
    const claims: CheckoutClaims = {
      workspaceId: input.workspaceId,
      plan: input.plan,
      interval: input.interval,
      nonce: randomBytes(12).toString("base64url"),
      expires: Date.now() + CHECKOUT_TTL_MS,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const origin = new URL(input.successUrl).origin;
    return { url: `${origin}/api/billing/mock/complete?token=${payload}.${sign(payload)}` };
  }

  async createPortalSession(input: { returnUrl: string }) {
    return { url: input.returnUrl };
  }

  async cancelSubscription(input: CancelInput) {
    await this.deliver({
      id: `mock_evt_${randomUUID()}`,
      type: "subscription.canceled",
      workspaceId: input.workspaceId,
      plan: input.plan,
      interval: input.interval,
      status: "canceled",
      currentPeriodEnd: input.currentPeriodEnd,
      providerCustomerId: input.providerCustomerId,
      providerSubscriptionId: input.providerSubscriptionId,
    });
  }

  /** Checks a link made by `createCheckout`; null when it was tampered with or has expired. */
  readCheckoutToken(token: string, now: Date = new Date()): CheckoutClaims | null {
    const [payload, signature] = token.split(".");
    if (!payload || !matches(payload, signature ?? null)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CheckoutClaims;
      return claims.expires > now.getTime() ? claims : null;
    } catch {
      return null;
    }
  }

  /** What "paying" does: a signed `subscription.updated` for the link's workspace. Reusing the link repeats the same event id. */
  completeCheckout(claims: CheckoutClaims, now: Date = new Date()) {
    return this.deliver({
      id: `mock_evt_checkout_${claims.nonce}`,
      type: "subscription.updated",
      workspaceId: claims.workspaceId,
      plan: claims.plan,
      interval: claims.interval,
      status: "active",
      currentPeriodEnd: addPeriod(now, claims.interval),
      providerCustomerId: `mock_cus_${claims.workspaceId}`,
      providerSubscriptionId: `mock_sub_${claims.nonce}`,
    });
  }

  /** Sign an event as the provider would and hand it to the webhook path. */
  async deliver(event: BillingEvent) {
    const rawBody = JSON.stringify({ ...event, currentPeriodEnd: event.currentPeriodEnd.toISOString() });
    return receiveWebhook(this, rawBody, new Headers({ [MOCK_SIGNATURE_HEADER]: sign(rawBody) }));
  }

  async parseWebhook(rawBody: string, headers: Headers): Promise<BillingEvent | null> {
    if (!matches(rawBody, headers.get(MOCK_SIGNATURE_HEADER))) throw new BillingSignatureError("bad signature");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new BillingPayloadError("not json");
    }
    const periodEnd = new Date(String(body.currentPeriodEnd));
    const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
    const id = text(body.id);
    const type = text(body.type);
    const workspaceId = text(body.workspaceId);
    const customer = text(body.providerCustomerId);
    const subscription = text(body.providerSubscriptionId);
    const plan = body.plan === "pro" || body.plan === "team" ? body.plan : null;
    const interval = body.interval === "month" || body.interval === "year" ? body.interval : null;
    const status = ["active", "trialing", "past_due", "canceled"].includes(String(body.status))
      ? (body.status as BillingEvent["status"])
      : null;
    if (!id || !type || !workspaceId || !customer || !subscription || !plan || !interval || !status || Number.isNaN(periodEnd.getTime())) {
      throw new BillingPayloadError("missing fields");
    }
    return { id, type, workspaceId, plan, interval, status, currentPeriodEnd: periodEnd, providerCustomerId: customer, providerSubscriptionId: subscription };
  }
}
