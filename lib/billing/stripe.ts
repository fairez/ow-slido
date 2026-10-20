import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingInterval } from "@/lib/plans";
import {
  BillingNotConfiguredError,
  BillingPayloadError,
  BillingProviderError,
  BillingSignatureError,
  type BillingEvent,
  type BillingProvider,
  type CancelInput,
  type CheckoutInput,
  type PaidPlan,
} from "./types";

const API = "https://api.stripe.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;
/** Stripe's own libraries use five minutes. */
export const STRIPE_TOLERANCE_SECONDS = 300;

const PRICE_ENV: Record<PaidPlan, Record<BillingInterval, string>> = {
  pro: { month: "STRIPE_PRICE_PRO_MONTH", year: "STRIPE_PRICE_PRO_YEAR" },
  team: { month: "STRIPE_PRICE_TEAM_MONTH", year: "STRIPE_PRICE_TEAM_YEAR" },
};

type StripeOptions = {
  /** Replaced in tests; defaults to the global `fetch` at call time. */
  fetch?: typeof fetch;
  now?: () => Date;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new BillingNotConfiguredError(`${name} is required when BILLING_PROVIDER=stripe`);
  return value;
}

/** Stripe's form encoding takes nested keys flat, as `a[b][0]`. */
function encode(params: Record<string, string | number | boolean>): string {
  return new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const asText = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
const asSeconds = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Talks to Stripe's REST API with `fetch`; no SDK. Keys and price ids are read from the environment
 * when used, so a missing one only fails the call that needs it. Nothing here logs request or response bodies.
 */
export class StripeProvider implements BillingProvider {
  readonly id = "stripe";
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => Date;

  constructor(options: StripeOptions = {}) {
    this.fetchImpl = options.fetch;
    this.now = options.now ?? (() => new Date());
  }

  private priceId(plan: PaidPlan, interval: BillingInterval): string {
    return required(PRICE_ENV[plan][interval]);
  }

  private planForPrice(priceId: string): { plan: PaidPlan; interval: BillingInterval } | null {
    for (const plan of Object.keys(PRICE_ENV) as PaidPlan[]) {
      for (const interval of ["month", "year"] as const) {
        if (process.env[PRICE_ENV[plan][interval]] === priceId) return { plan, interval };
      }
    }
    return null;
  }

  private async post(path: string, params: Parameters<typeof encode>[0]): Promise<Record<string, unknown>> {
    const response = await (this.fetchImpl ?? fetch)(`${API}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${required("STRIPE_SECRET_KEY")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: encode(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = asRecord(await response.json().catch(() => null));
    if (!response.ok) {
      const message = asText(asRecord(body?.error)?.message) ?? "request failed";
      throw new BillingProviderError(`Stripe ${response.status}: ${message}`, response.status);
    }
    if (!body) throw new BillingProviderError("Stripe returned an unreadable response", response.status);
    return body;
  }

  async createCheckout(input: CheckoutInput) {
    const session = await this.post("/checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": this.priceId(input.plan, input.interval),
      "line_items[0][quantity]": 1,
      customer_email: input.customerEmail,
      client_reference_id: input.workspaceId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      "metadata[workspaceId]": input.workspaceId,
      // The webhook reads the workspace from the subscription, which only carries this copy.
      "subscription_data[metadata][workspaceId]": input.workspaceId,
    });
    const url = asText(session.url);
    if (!url) throw new BillingProviderError("Stripe returned no checkout url", 200);
    return { url };
  }

  async createPortalSession(input: { workspaceId: string; providerCustomerId: string; returnUrl: string }) {
    const session = await this.post("/billing_portal/sessions", { customer: input.providerCustomerId, return_url: input.returnUrl });
    const url = asText(session.url);
    if (!url) throw new BillingProviderError("Stripe returned no portal url", 200);
    return { url };
  }

  /** Stops renewal at the period end. The `customer.subscription.updated` webhook records it. */
  async cancelSubscription(input: CancelInput) {
    await this.post(`/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`, { cancel_at_period_end: true });
  }

  /** Checks `Stripe-Signature` (`t=<unix>,v1=<hmac>`, HMAC-SHA256 over `t.body`) and the timestamp tolerance. */
  verifySignature(rawBody: string, header: string | null): void {
    if (!header) throw new BillingSignatureError("missing signature");
    let timestamp = "";
    const signatures: string[] = [];
    for (const part of header.split(",")) {
      const [key, value] = part.split("=");
      if (key?.trim() === "t") timestamp = value ?? "";
      if (key?.trim() === "v1" && value) signatures.push(value);
    }
    const issued = Number(timestamp);
    if (!timestamp || !Number.isFinite(issued) || signatures.length === 0) throw new BillingSignatureError("malformed signature");

    const expected = createHmac("sha256", required("STRIPE_WEBHOOK_SECRET")).update(`${timestamp}.${rawBody}`).digest();
    const valid = signatures.some((signature) => {
      const given = Buffer.from(signature, "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!valid) throw new BillingSignatureError("bad signature");
    if (Math.abs(this.now().getTime() / 1000 - issued) > STRIPE_TOLERANCE_SECONDS) throw new BillingSignatureError("timestamp outside tolerance");
  }

  async parseWebhook(rawBody: string, headers: Headers): Promise<BillingEvent | null> {
    this.verifySignature(rawBody, headers.get("stripe-signature"));
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(rawBody));
    } catch {
      throw new BillingPayloadError("not json");
    }
    const id = asText(event?.id);
    const type = asText(event?.type);
    if (!event || !id || !type) throw new BillingPayloadError("missing fields");
    if (!type.startsWith("customer.subscription.")) return null;

    const subscription = asRecord(asRecord(event.data)?.object);
    const subscriptionId = asText(subscription?.id);
    const customerId = asText(subscription?.customer);
    if (!subscription || !subscriptionId || !customerId) throw new BillingPayloadError("missing subscription");

    // A subscription made outside our checkout has no workspace; it is not ours to track.
    const workspaceId = asText(asRecord(subscription.metadata)?.workspaceId);
    const items = asRecord(subscription.items)?.data;
    const item = asRecord(Array.isArray(items) ? items[0] : null);
    const price = asText(asRecord(item?.price)?.id);
    const tier = price ? this.planForPrice(price) : null;
    if (!workspaceId || !tier) return null;

    // Newer API versions put the period on the item, older ones on the subscription.
    const periodSeconds = asSeconds(item?.current_period_end) ?? asSeconds(subscription.current_period_end);
    if (periodSeconds === null) throw new BillingPayloadError("missing period end");

    let status: BillingEvent["status"] | null;
    let periodEnd = new Date(periodSeconds * 1000);
    switch (asText(subscription.status)) {
      case "active":
        // Canceling in Stripe keeps the status `active` until the end; we show it as canceled with an end date.
        status = subscription.cancel_at_period_end === true ? "canceled" : "active";
        break;
      case "trialing":
        status = subscription.cancel_at_period_end === true ? "canceled" : "trialing";
        break;
      case "past_due":
        status = "past_due";
        break;
      case "canceled":
      case "unpaid":
      case "paused": {
        status = "canceled";
        // An immediate cancel ends access now, not at the period end it would have had.
        const ended = asSeconds(subscription.ended_at);
        if (ended !== null && ended * 1000 < periodEnd.getTime()) periodEnd = new Date(ended * 1000);
        break;
      }
      default:
        // incomplete / incomplete_expired: payment never went through, so there is nothing to grant.
        status = null;
    }
    if (!status) return null;

    return {
      id,
      type,
      workspaceId,
      plan: tier.plan,
      interval: tier.interval,
      status,
      currentPeriodEnd: periodEnd,
      providerCustomerId: customerId,
      providerSubscriptionId: subscriptionId,
    };
  }
}
