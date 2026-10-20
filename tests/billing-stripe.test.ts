// @vitest-environment node
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { subscriptions, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { getBillingProvider, receiveWebhook, BillingNotConfiguredError, BillingPayloadError, BillingProviderError, BillingSignatureError } from "@/lib/billing";
import { StripeProvider } from "@/lib/billing/stripe";
import { billingErrorResponse } from "@/lib/billing/http";
import { getEntitlements } from "@/lib/plans";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();
const WEBHOOK_SECRET = "whsec_test_fixed";
const NOW = new Date("2031-03-01T12:00:00Z");
const PERIOD_END = Math.floor(new Date("2031-04-01T00:00:00Z").getTime() / 1000);

let workspaceId: string;

beforeAll(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
});
beforeEach(async () => {
  vi.stubEnv("BILLING_PROVIDER", "stripe");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixed");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("STRIPE_PRICE_PRO_MONTH", "price_pro_month");
  vi.stubEnv("STRIPE_PRICE_PRO_YEAR", "price_pro_year");
  vi.stubEnv("STRIPE_PRICE_TEAM_MONTH", "price_team_month");
  vi.stubEnv("STRIPE_PRICE_TEAM_YEAR", "price_team_year");
  await truncateAll(db);
  const [user] = await db
    .insert(users)
    .values({ email: "owner@example.com", passwordHash: await hashPassword("correct horse battery"), emailVerifiedAt: new Date() })
    .returning();
  workspaceId = (await createPersonalWorkspace(db, user)).id;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => pool.end());

/** A fetch that records what it was asked and answers with canned JSON. Never touches the network. */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}
const form = (call: { init: RequestInit }) => new URLSearchParams(String(call.init.body));
const header = (call: { init: RequestInit }, name: string) => new Headers(call.init.headers).get(name);

const provider = (fetchImpl?: typeof fetch) => new StripeProvider({ fetch: fetchImpl, now: () => NOW });

// --- outgoing calls ---

test("checkout creates a subscription session for the chosen price and tags the workspace", async () => {
  const { impl, calls } = fakeFetch({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
  const result = await provider(impl).createCheckout({
    workspaceId,
    plan: "team",
    interval: "year",
    customerEmail: "owner@example.com",
    successUrl: "https://app.test/dashboard/plan?checkout=success",
    cancelUrl: "https://app.test/dashboard/plan?checkout=canceled",
  });
  expect(result.url).toBe("https://checkout.stripe.com/c/pay/cs_1");

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
  expect(calls[0].init.method).toBe("POST");
  expect(header(calls[0], "authorization")).toBe("Bearer sk_test_fixed");
  const params = form(calls[0]);
  expect(params.get("mode")).toBe("subscription");
  expect(params.get("line_items[0][price]")).toBe("price_team_year");
  expect(params.get("line_items[0][quantity]")).toBe("1");
  expect(params.get("customer_email")).toBe("owner@example.com");
  expect(params.get("client_reference_id")).toBe(workspaceId);
  expect(params.get("subscription_data[metadata][workspaceId]")).toBe(workspaceId);
  expect(params.get("success_url")).toContain("checkout=success");
});

test("portal and cancel call the matching Stripe endpoints", async () => {
  const portal = fakeFetch({ url: "https://billing.stripe.com/p/session/x" });
  const opened = await provider(portal.impl).createPortalSession({ workspaceId, providerCustomerId: "cus_9", returnUrl: "https://app.test/dashboard/plan" });
  expect(opened.url).toBe("https://billing.stripe.com/p/session/x");
  expect(portal.calls[0].url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
  expect(form(portal.calls[0]).get("customer")).toBe("cus_9");
  expect(form(portal.calls[0]).get("return_url")).toBe("https://app.test/dashboard/plan");

  const cancel = fakeFetch({ id: "sub_9", cancel_at_period_end: true });
  await provider(cancel.impl).cancelSubscription({
    workspaceId,
    providerSubscriptionId: "sub_9",
    providerCustomerId: "cus_9",
    plan: "pro",
    interval: "month",
    currentPeriodEnd: new Date(PERIOD_END * 1000),
  });
  expect(cancel.calls[0].url).toBe("https://api.stripe.com/v1/subscriptions/sub_9");
  expect(form(cancel.calls[0]).get("cancel_at_period_end")).toBe("true");
});

test("a Stripe error becomes a BillingProviderError that carries Stripe's message and no key", async () => {
  const { impl } = fakeFetch({ error: { message: "No such price: 'price_pro_month'" } }, 400);
  const failure = await provider(impl)
    .createCheckout({ workspaceId, plan: "pro", interval: "month", customerEmail: "a@b.co", successUrl: "https://app.test/x", cancelUrl: "https://app.test/y" })
    .catch((e) => e);
  expect(failure).toBeInstanceOf(BillingProviderError);
  expect(failure.status).toBe(400);
  expect(failure.message).toContain("No such price");
  expect(failure.message).not.toContain("sk_test_fixed");
});

test("route helper answers 502 for a provider failure and 503 for missing settings", async () => {
  const request = new Request("http://localhost/api/billing/checkout");
  expect(billingErrorResponse(request, new BillingProviderError("x", 500))?.status).toBe(502);
  expect(billingErrorResponse(request, new BillingNotConfiguredError("x"))?.status).toBe(503);
  expect(billingErrorResponse(request, new Error("x"))).toBeNull();
});

test("missing settings fail the call that needs them, before any request is made", async () => {
  const { impl, calls } = fakeFetch({});
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  await expect(provider(impl).createPortalSession({ workspaceId, providerCustomerId: "cus_1", returnUrl: "https://app.test/" })).rejects.toThrow(/STRIPE_SECRET_KEY/);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixed");
  vi.stubEnv("STRIPE_PRICE_PRO_YEAR", "");
  await expect(
    provider(impl).createCheckout({ workspaceId, plan: "pro", interval: "year", customerEmail: "a@b.co", successUrl: "https://app.test/x", cancelUrl: "https://app.test/y" }),
  ).rejects.toThrow(/STRIPE_PRICE_PRO_YEAR/);
  expect(calls).toHaveLength(0);
});

test("the provider is chosen by BILLING_PROVIDER=stripe only", () => {
  expect(getBillingProvider().id).toBe("stripe");
  vi.stubEnv("BILLING_PROVIDER", "mock");
  expect(getBillingProvider().id).toBe("mock");
});

// --- webhooks ---

function subscriptionEvent(overrides: { id?: string; type?: string; sub?: Record<string, unknown> } = {}) {
  return {
    id: overrides.id ?? "evt_1",
    type: overrides.type ?? "customer.subscription.updated",
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        cancel_at_period_end: false,
        metadata: { workspaceId },
        items: { data: [{ price: { id: "price_pro_month" }, current_period_end: PERIOD_END }] },
        ...overrides.sub,
      },
    },
  };
}
function signed(body: object, at: Date = NOW, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(body);
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return { raw, headers: new Headers({ "stripe-signature": `t=${t},v1=${v1}` }) };
}
const parse = (body: object, at?: Date) => {
  const { raw, headers } = signed(body, at);
  return provider().parseWebhook(raw, headers);
};
const rowFor = async () => (await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId)))[0];

test("an active subscription maps to its plan, interval and period end", async () => {
  expect(await parse(subscriptionEvent())).toEqual({
    id: "evt_1",
    type: "customer.subscription.updated",
    workspaceId,
    plan: "pro",
    interval: "month",
    status: "active",
    currentPeriodEnd: new Date(PERIOD_END * 1000),
    providerCustomerId: "cus_1",
    providerSubscriptionId: "sub_1",
  });
  const team = await parse(subscriptionEvent({ sub: { items: { data: [{ price: { id: "price_team_year" }, current_period_end: PERIOD_END }] } } }));
  expect(team).toMatchObject({ plan: "team", interval: "year" });
});

test("older API versions keep the period end on the subscription", async () => {
  const event = subscriptionEvent({ sub: { items: { data: [{ price: { id: "price_pro_month" } }] }, current_period_end: PERIOD_END } });
  expect((await parse(event))?.currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000));
});

test("cancel at period end shows as canceled with the end date; undoing it makes it active again", async () => {
  expect(await parse(subscriptionEvent({ sub: { cancel_at_period_end: true } }))).toMatchObject({
    status: "canceled",
    currentPeriodEnd: new Date(PERIOD_END * 1000),
  });
  expect(await parse(subscriptionEvent({ sub: { cancel_at_period_end: false } }))).toMatchObject({ status: "active" });
});

test("past due, trialing and ended subscriptions map to our statuses", async () => {
  expect(await parse(subscriptionEvent({ sub: { status: "past_due" } }))).toMatchObject({ status: "past_due" });
  expect(await parse(subscriptionEvent({ sub: { status: "trialing" } }))).toMatchObject({ status: "trialing" });
  expect(await parse(subscriptionEvent({ sub: { status: "unpaid" } }))).toMatchObject({ status: "canceled" });

  const ended = Math.floor(new Date("2031-03-10T00:00:00Z").getTime() / 1000);
  const deleted = await parse(subscriptionEvent({ type: "customer.subscription.deleted", sub: { status: "canceled", ended_at: ended } }));
  expect(deleted).toMatchObject({ status: "canceled", currentPeriodEnd: new Date(ended * 1000) });
});

test("events we do not act on return null", async () => {
  expect(await parse({ id: "evt_2", type: "invoice.paid", data: { object: {} } })).toBeNull();
  expect(await parse(subscriptionEvent({ sub: { status: "incomplete" } }))).toBeNull();
  expect(await parse(subscriptionEvent({ sub: { metadata: {} } }))).toBeNull();
  expect(await parse(subscriptionEvent({ sub: { items: { data: [{ price: { id: "price_other" }, current_period_end: PERIOD_END }] } } }))).toBeNull();
});

test("a bad signature, a wrong secret, a stale timestamp or no header are refused", async () => {
  const body = subscriptionEvent();
  const { raw, headers } = signed(body);

  await expect(provider().parseWebhook(raw + " ", headers)).rejects.toBeInstanceOf(BillingSignatureError);
  const wrongSecret = signed(body, NOW, "whsec_other");
  await expect(provider().parseWebhook(wrongSecret.raw, wrongSecret.headers)).rejects.toBeInstanceOf(BillingSignatureError);
  await expect(provider().parseWebhook(raw, new Headers())).rejects.toBeInstanceOf(BillingSignatureError);
  await expect(provider().parseWebhook(raw, new Headers({ "stripe-signature": "t=abc,v1=00" }))).rejects.toBeInstanceOf(BillingSignatureError);

  const stale = signed(body, new Date(NOW.getTime() - 301_000));
  await expect(provider().parseWebhook(stale.raw, stale.headers)).rejects.toBeInstanceOf(BillingSignatureError);
  const edge = signed(body, new Date(NOW.getTime() - 299_000));
  await expect(provider().parseWebhook(edge.raw, edge.headers)).resolves.toBeTruthy();
});

test("any one valid v1 signature in the header is enough", async () => {
  const { raw, headers } = signed(subscriptionEvent());
  const valid = headers.get("stripe-signature")!;
  const mixed = new Headers({ "stripe-signature": valid.replace("v1=", "v1=" + "00".repeat(32) + ",v1=") });
  await expect(provider().parseWebhook(raw, mixed)).resolves.toBeTruthy();
});

test("a signed body that is not JSON or lacks an event id is a payload error", async () => {
  const notJson = signed({});
  const t = Math.floor(NOW.getTime() / 1000);
  const raw = "not json";
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${raw}`).digest("hex");
  await expect(provider().parseWebhook(raw, new Headers({ "stripe-signature": `t=${t},v1=${v1}` }))).rejects.toBeInstanceOf(BillingPayloadError);
  await expect(provider().parseWebhook(notJson.raw, notJson.headers)).rejects.toBeInstanceOf(BillingPayloadError);
  const noPeriod = subscriptionEvent({ sub: { items: { data: [{ price: { id: "price_pro_month" } }] } } });
  await expect(parse(noPeriod)).rejects.toBeInstanceOf(BillingPayloadError);
});

test("a verified Stripe event updates the subscription once, and a redelivery changes nothing", async () => {
  const { raw, headers } = signed(subscriptionEvent());
  expect(await receiveWebhook(provider(), raw, headers, db)).toBe("applied");
  expect(await rowFor()).toMatchObject({
    plan: "pro",
    status: "active",
    interval: "month",
    provider: "stripe",
    providerCustomerId: "cus_1",
    providerSubscriptionId: "sub_1",
  });
  expect((await getEntitlements(workspaceId, { db, now: NOW })).plan).toBe("pro");

  expect(await receiveWebhook(provider(), raw, headers, db)).toBe("duplicate");

  const cancel = signed(subscriptionEvent({ id: "evt_2", sub: { cancel_at_period_end: true } }));
  expect(await receiveWebhook(provider(), cancel.raw, cancel.headers, db)).toBe("applied");
  expect(await rowFor()).toMatchObject({ status: "canceled" });
  expect((await getEntitlements(workspaceId, { db, now: NOW })).plan).toBe("pro");
});

test("the webhook route accepts a Stripe event and rejects a forged one", async () => {
  const route = (await import("@/app/api/billing/webhook/route")).POST;
  const { raw, headers } = signed(subscriptionEvent({ id: "evt_route" }), new Date());
  const ok = await route(new Request("http://localhost/api/billing/webhook", { method: "POST", headers, body: raw }));
  expect(ok.status).toBe(200);
  expect((await rowFor()).provider).toBe("stripe");

  const forged = signed(subscriptionEvent({ id: "evt_forged" }), new Date(), "whsec_attacker");
  const bad = await route(new Request("http://localhost/api/billing/webhook", { method: "POST", headers: forged.headers, body: forged.raw }));
  expect(bad.status).toBe(400);
});
