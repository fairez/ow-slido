// @vitest-environment node
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { subscriptions } from "@/db/schema";
import { getBillingControls } from "@/lib/billing/status";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { users } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

beforeEach(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  vi.stubEnv("BILLING_PROVIDER", "mock");
  await truncateAll(db);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => pool.end());

async function workspace() {
  const [user] = await db.insert(users).values({ email: "owner@example.com", passwordHash: "x" }).returning();
  return (await createPersonalWorkspace(db, user)).id;
}

const paid = (workspaceId: string, patch: Partial<typeof subscriptions.$inferInsert> = {}) =>
  db.insert(subscriptions).values({
    workspaceId,
    plan: "pro",
    status: "active",
    interval: "month",
    currentPeriodEnd: new Date("2031-01-01T00:00:00Z"),
    provider: "mock",
    providerCustomerId: "cus_1",
    providerSubscriptionId: "sub_1",
    ...patch,
  });

test("a Free workspace can check out but has nothing to manage or cancel", async () => {
  const id = await workspace();
  expect(await getBillingControls(id)).toEqual({ configured: true, portal: false, cancel: false, changeVia: "checkout" });
});

test("an active subscription can open the portal and be canceled", async () => {
  const id = await workspace();
  await db.delete(subscriptions);
  await paid(id);
  expect(await getBillingControls(id)).toEqual({ configured: true, portal: true, cancel: true, changeVia: "checkout" });
});

test("a canceled subscription keeps the portal but cannot be canceled again, and a new plan starts a checkout", async () => {
  const id = await workspace();
  await db.delete(subscriptions);
  await paid(id, { status: "canceled" });
  expect(await getBillingControls(id)).toEqual({ configured: true, portal: true, cancel: false, changeVia: "checkout" });
});

test("a subscription made at another provider is not offered here", async () => {
  const id = await workspace();
  await db.delete(subscriptions);
  await paid(id, { provider: "stripe" });
  expect(await getBillingControls(id)).toEqual({ configured: true, portal: false, cancel: false, changeVia: "checkout" });
});

test("a live Stripe subscription changes plan in the portal, not through a second checkout", async () => {
  vi.stubEnv("BILLING_PROVIDER", "stripe");
  const id = await workspace();
  await db.delete(subscriptions);
  await paid(id, { provider: "stripe" });
  expect(await getBillingControls(id)).toEqual({ configured: true, portal: true, cancel: true, changeVia: "portal" });
});

test("without a provider the plan page offers no billing", async () => {
  vi.stubEnv("BILLING_PROVIDER", "");
  vi.stubEnv("NODE_ENV", "production");
  const id = await workspace();
  expect(await getBillingControls(id)).toEqual({ configured: false, portal: false, cancel: false, changeVia: "checkout" });
});
