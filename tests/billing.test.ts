// @vitest-environment node
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { billingEvents, memberships, subscriptions, users, workspaces } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { getEntitlements } from "@/lib/plans";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();
const SECRET = "whsec-test-secret";

type Handler = (req: Request) => Promise<Response>;
let checkout: Handler;
let portal: Handler;
let cancel: Handler;
let webhook: Handler;
let complete: Handler;
let session: typeof import("@/lib/auth/session");
const passwordHash = hashPassword("correct horse battery");

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  checkout = (await import("@/app/api/billing/checkout/route")).POST;
  portal = (await import("@/app/api/billing/portal/route")).POST;
  cancel = (await import("@/app/api/billing/cancel/route")).POST;
  webhook = (await import("@/app/api/billing/webhook/route")).POST;
  complete = (await import("@/app/api/billing/mock/complete/route")).GET;
  session = await import("@/lib/auth/session");
});
beforeEach(async () => {
  vi.stubEnv("BILLING_PROVIDER", "mock");
  vi.stubEnv("BILLING_WEBHOOK_SECRET", SECRET);
  await truncateAll(db);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => pool.end());

const req = (method: string, path: string, body?: unknown, cookie?: string) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function makeUser(email: string, opts: { verified?: boolean } = {}) {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await passwordHash, emailVerifiedAt: opts.verified === false ? null : new Date() })
    .returning();
  const workspace = await createPersonalWorkspace(db, user);
  return { user, workspaceId: workspace.id, cookie: `session=${session.createSessionToken(user.id)}` };
}

async function makeAdmin(workspaceId: string) {
  const other = await makeUser("admin@example.com");
  await db.insert(memberships).values({ workspaceId, userId: other.user.id, role: "admin", status: "active" });
  return `${other.cookie}; workspace=${workspaceId}`;
}

const startCheckout = (cookie: string, plan = "pro", interval = "month") =>
  checkout(req("POST", "/api/billing/checkout", { plan, interval }, cookie));

/** Runs the mock provider's checkout end to end: ask for the link, then open it. */
async function pay(cookie: string, plan = "pro", interval = "month") {
  const { url } = (await (await startCheckout(cookie, plan, interval)).json()) as { url: string };
  const target = new URL(url);
  return complete(req("GET", target.pathname + target.search, undefined, cookie));
}

const sign = (raw: string, secret = SECRET) => createHmac("sha256", secret).update(raw).digest("hex");
const sendWebhook = (body: object, signature?: string) => {
  const raw = JSON.stringify(body);
  return webhook(
    new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "x-mock-signature": signature ?? sign(raw) },
      body: raw,
    }),
  );
};
const eventFor = (workspaceId: string, overrides: Record<string, unknown> = {}) => ({
  id: "evt_1",
  type: "subscription.updated",
  workspaceId,
  plan: "pro",
  interval: "month",
  status: "active",
  currentPeriodEnd: "2031-01-01T00:00:00.000Z",
  providerCustomerId: "cus_1",
  providerSubscriptionId: "sub_1",
  ...overrides,
});
/** Undefined while a workspace has no row, which is the same as Free. */
const rowFor = async (workspaceId: string) =>
  (await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId)))[0];

// --- checkout ---

test("checkout through the mock provider makes the workspace Pro", async () => {
  const owner = await makeUser("owner@example.com");
  const res = await pay(owner.cookie, "pro", "year");
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/dashboard/plan?checkout=success");

  const row = await rowFor(owner.workspaceId);
  expect(row).toMatchObject({ plan: "pro", status: "active", interval: "year", provider: "mock" });
  expect(row.providerSubscriptionId).toBeTruthy();
  const yearAhead = Date.now() + 364 * 86_400_000;
  expect(row.currentPeriodEnd!.getTime()).toBeGreaterThan(yearAhead);
  expect((await getEntitlements(owner.workspaceId, { db })).plan).toBe("pro");
});

test("only billing.manage may start checkout, and the email must be verified", async () => {
  const owner = await makeUser("owner@example.com");
  expect((await startCheckout(await makeAdmin(owner.workspaceId))).status).toBe(403);
  expect((await checkout(req("POST", "/api/billing/checkout", { plan: "pro", interval: "month" }))).status).toBe(401);

  const unverified = await makeUser("new@example.com", { verified: false });
  const res = await startCheckout(unverified.cookie);
  expect(res.status).toBe(403);
  expect((await res.json()).reason).toBe("email_unverified");
});

test("checkout rejects plans that cannot be bought", async () => {
  const owner = await makeUser("owner@example.com");
  for (const body of [{ plan: "free", interval: "month" }, { plan: "gold", interval: "month" }, { plan: "pro", interval: "week" }, {}]) {
    expect((await checkout(req("POST", "/api/billing/checkout", body, owner.cookie))).status).toBe(400);
  }
});

test("a checkout link only works for the workspace it was made for, and once tampered it is refused", async () => {
  const owner = await makeUser("owner@example.com");
  const stranger = await makeUser("stranger@example.com");
  const { url } = (await (await startCheckout(owner.cookie)).json()) as { url: string };
  const target = new URL(url);

  const wrongWorkspace = await complete(req("GET", target.pathname + target.search, undefined, stranger.cookie));
  expect(wrongWorkspace.status).toBe(400);

  const token = target.searchParams.get("token")!;
  const forged = `${token.split(".")[0]}.${"0".repeat(64)}`;
  expect((await complete(req("GET", `/api/billing/mock/complete?token=${forged}`, undefined, owner.cookie))).status).toBe(400);
  expect((await complete(req("GET", "/api/billing/mock/complete", undefined, owner.cookie))).status).toBe(400);
  expect(await rowFor(stranger.workspaceId)).toBeUndefined();
  expect(await rowFor(owner.workspaceId)).toBeUndefined();
});

test("opening the same checkout link twice applies it once", async () => {
  const owner = await makeUser("owner@example.com");
  const { url } = (await (await startCheckout(owner.cookie)).json()) as { url: string };
  const target = new URL(url);
  for (let i = 0; i < 2; i++) {
    expect((await complete(req("GET", target.pathname + target.search, undefined, owner.cookie))).status).toBe(303);
  }
  expect(await db.select().from(billingEvents)).toHaveLength(1);
});

test("billing is off in production unless a provider is named", async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BILLING_PROVIDER", "");
  const owner = await makeUser("owner@example.com");
  expect((await startCheckout(owner.cookie)).status).toBe(503);
  expect((await sendWebhook(eventFor(owner.workspaceId))).status).toBe(503);
  expect(await rowFor(owner.workspaceId)).toBeUndefined();
});

// --- webhook ---

test("a signed webhook updates the subscription", async () => {
  const owner = await makeUser("owner@example.com");
  const res = await sendWebhook(eventFor(owner.workspaceId, { plan: "team", interval: "year" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ received: true, result: "applied" });
  expect(await rowFor(owner.workspaceId)).toMatchObject({
    plan: "team",
    interval: "year",
    status: "active",
    provider: "mock",
    providerCustomerId: "cus_1",
    providerSubscriptionId: "sub_1",
  });
  expect((await rowFor(owner.workspaceId)).currentPeriodEnd!.toISOString()).toBe("2031-01-01T00:00:00.000Z");
});

test("webhooks with a bad, missing or foreign signature change nothing", async () => {
  const owner = await makeUser("owner@example.com");
  const body = eventFor(owner.workspaceId);
  const raw = JSON.stringify(body);

  expect((await sendWebhook(body, sign(raw, "another-secret"))).status).toBe(400);
  expect((await sendWebhook(body, "not-hex")).status).toBe(400);
  expect((await sendWebhook(body, sign(raw).slice(0, 10))).status).toBe(400);
  const unsigned = await webhook(new Request("http://localhost/api/billing/webhook", { method: "POST", body: raw }));
  expect(unsigned.status).toBe(400);
  const tampered = await webhook(
    new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "x-mock-signature": sign(raw) },
      body: raw.replace('"pro"', '"team"'),
    }),
  );
  expect(tampered.status).toBe(400);

  expect(await rowFor(owner.workspaceId)).toBeUndefined();
  expect(await db.select().from(billingEvents)).toHaveLength(0);
});

test("a signed but malformed event is a 400", async () => {
  const owner = await makeUser("owner@example.com");
  expect((await sendWebhook(eventFor(owner.workspaceId, { plan: "free" }))).status).toBe(400);
  expect((await sendWebhook(eventFor(owner.workspaceId, { status: "weird" }))).status).toBe(400);
  expect((await sendWebhook(eventFor(owner.workspaceId, { currentPeriodEnd: "soon" }))).status).toBe(400);
  const raw = "not json";
  const res = await webhook(
    new Request("http://localhost/api/billing/webhook", { method: "POST", headers: { "x-mock-signature": sign(raw) }, body: raw }),
  );
  expect(res.status).toBe(400);
});

test("redelivering an event changes nothing", async () => {
  const owner = await makeUser("owner@example.com");
  expect((await (await sendWebhook(eventFor(owner.workspaceId))).json()).result).toBe("applied");
  const again = await sendWebhook(eventFor(owner.workspaceId, { plan: "team", status: "canceled" }));
  expect(again.status).toBe(200);
  expect((await again.json()).result).toBe("duplicate");
  expect(await rowFor(owner.workspaceId)).toMatchObject({ plan: "pro", status: "active" });
  expect(await db.select().from(billingEvents)).toHaveLength(1);
});

test("parallel deliveries of one event apply it once", async () => {
  const owner = await makeUser("owner@example.com");
  const results = await Promise.all(
    Array.from({ length: 4 }, async () => (await (await sendWebhook(eventFor(owner.workspaceId))).json()).result),
  );
  expect(results.filter((r) => r === "applied")).toHaveLength(1);
  expect(await db.select().from(billingEvents)).toHaveLength(1);
});

test("an event for a workspace that does not exist is acknowledged and ignored", async () => {
  const res = await sendWebhook(eventFor("00000000-0000-4000-8000-000000000000"));
  expect(res.status).toBe(200);
  expect((await res.json()).result).toBe("ignored");
  expect(await db.select().from(billingEvents)).toHaveLength(0);
});

test("a payment failure event moves the workspace to past_due and keeps the plan override", async () => {
  const owner = await makeUser("owner@example.com");
  await setPlan(db, owner.workspaceId, "team");
  await sendWebhook(eventFor(owner.workspaceId, { id: "evt_2", status: "past_due" }));
  const row = await rowFor(owner.workspaceId);
  expect(row).toMatchObject({ plan: "pro", status: "past_due", planOverride: "team" });
  expect((await getEntitlements(owner.workspaceId, { db })).plan).toBe("team");
});

test("deleting a workspace removes its billing events", async () => {
  const owner = await makeUser("owner@example.com");
  await sendWebhook(eventFor(owner.workspaceId));
  expect(await db.select().from(billingEvents)).toHaveLength(1);
  await db.delete(workspaces).where(eq(workspaces.id, owner.workspaceId));
  expect(await db.select().from(billingEvents)).toHaveLength(0);
});

// --- cancel and portal ---

test("cancel keeps paid access until the period end", async () => {
  const owner = await makeUser("owner@example.com");
  await pay(owner.cookie);
  const before = await rowFor(owner.workspaceId);

  const res = await cancel(req("POST", "/api/billing/cancel", undefined, owner.cookie));
  expect(res.status).toBe(200);
  const row = await rowFor(owner.workspaceId);
  expect(row).toMatchObject({ plan: "pro", status: "canceled" });
  expect(row.currentPeriodEnd!.getTime()).toBe(before.currentPeriodEnd!.getTime());

  const entitlements = await getEntitlements(owner.workspaceId, { db });
  expect(entitlements.plan).toBe("pro");
  expect(entitlements.accessEndsAt?.getTime()).toBe(before.currentPeriodEnd!.getTime());
  const afterEnd = await getEntitlements(owner.workspaceId, { db, now: new Date(before.currentPeriodEnd!.getTime() + 1000) });
  expect(afterEnd.plan).toBe("free");

  expect((await cancel(req("POST", "/api/billing/cancel", undefined, owner.cookie))).status).toBe(409);
});

test("cancel needs a paid subscription and billing.manage", async () => {
  const owner = await makeUser("owner@example.com");
  expect((await cancel(req("POST", "/api/billing/cancel", undefined, owner.cookie))).status).toBe(409);
  await pay(owner.cookie);
  expect((await cancel(req("POST", "/api/billing/cancel", undefined, await makeAdmin(owner.workspaceId)))).status).toBe(403);
  expect((await rowFor(owner.workspaceId)).status).toBe("active");
});

test("the portal needs a customer and billing.manage", async () => {
  const owner = await makeUser("owner@example.com");
  expect((await portal(req("POST", "/api/billing/portal", undefined, owner.cookie))).status).toBe(409);
  await pay(owner.cookie);
  const res = await portal(req("POST", "/api/billing/portal", undefined, owner.cookie));
  expect(res.status).toBe(200);
  expect((await res.json()).url).toBe("http://localhost/dashboard/plan");
  expect((await portal(req("POST", "/api/billing/portal", undefined, await makeAdmin(owner.workspaceId)))).status).toBe(403);
});
