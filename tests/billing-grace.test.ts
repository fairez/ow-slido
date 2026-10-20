// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { subscriptions, users } from "@/db/schema";
import { applyBillingEvent } from "@/lib/billing/webhook";
import { expireSubscriptions } from "@/lib/billing/expire";
import type { BillingEvent } from "@/lib/billing/types";
import { getEntitlements, PAST_DUE_GRACE_DAYS } from "@/lib/plans";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();
afterAll(() => pool.end());
beforeEach(() => truncateAll(db));

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T09:00:00Z");
const at = (days: number, from = T0) => new Date(from.getTime() + days * DAY);

async function workspace(email = "owner@example.com") {
  const [user] = await db.insert(users).values({ email, passwordHash: "x", emailVerifiedAt: T0 }).returning();
  return (await createPersonalWorkspace(db, user)).id;
}

let seq = 0;
const event = (workspaceId: string, over: Partial<BillingEvent> = {}): BillingEvent => ({
  id: `evt_${++seq}`,
  type: "test",
  workspaceId,
  plan: "pro",
  interval: "month",
  status: "active",
  currentPeriodEnd: at(30),
  providerCustomerId: "cus_1",
  providerSubscriptionId: "sub_1",
  ...over,
});

const stored = async (workspaceId: string) =>
  (await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId)))[0];

describe("grace after a failed payment", () => {
  it("starts when past_due first arrives, not at the period end", async () => {
    const w = await workspace();
    await applyBillingEvent("mock", event(w), db, T0);
    // Renewal fails on day 30; the provider has already moved the period end a month ahead.
    const failedAt = at(30);
    await applyBillingEvent("mock", event(w, { status: "past_due", currentPeriodEnd: at(60) }), db, failedAt);

    expect((await stored(w)).pastDueSince).toEqual(failedAt);
    const during = await getEntitlements(w, { db, now: at(PAST_DUE_GRACE_DAYS - 1, failedAt) });
    expect(during).toMatchObject({ plan: "pro", source: "subscription", graceEndsAt: at(PAST_DUE_GRACE_DAYS, failedAt) });
  });

  it("ends exactly after the grace days and falls back to Free without a job", async () => {
    const w = await workspace();
    await applyBillingEvent("mock", event(w, { status: "past_due" }), db, T0);
    const last = await getEntitlements(w, { db, now: new Date(at(PAST_DUE_GRACE_DAYS).getTime() - 1) });
    expect(last.plan).toBe("pro");
    const over = await getEntitlements(w, { db, now: at(PAST_DUE_GRACE_DAYS) });
    expect(over).toMatchObject({ plan: "free", source: "free", status: "past_due", graceEndsAt: null });
  });

  it("does not restart the clock when past_due is reported again", async () => {
    const w = await workspace();
    await applyBillingEvent("mock", event(w, { status: "past_due" }), db, T0);
    await applyBillingEvent("mock", event(w, { status: "past_due" }), db, at(3));
    expect((await stored(w)).pastDueSince).toEqual(T0);
  });

  it("a successful payment ends the grace and a later failure starts a new one", async () => {
    const w = await workspace();
    await applyBillingEvent("mock", event(w, { status: "past_due" }), db, T0);
    await applyBillingEvent("mock", event(w, { status: "active" }), db, at(2));
    expect((await stored(w)).pastDueSince).toBeNull();
    expect(await getEntitlements(w, { db, now: at(20) })).toMatchObject({ plan: "pro", graceEndsAt: null });

    await applyBillingEvent("mock", event(w, { status: "past_due" }), db, at(40));
    expect((await stored(w)).pastDueSince).toEqual(at(40));
  });
});

describe("cancel at period end", () => {
  it("keeps the plan until the period ends, then is Free without a job", async () => {
    const w = await workspace();
    await applyBillingEvent("mock", event(w, { status: "canceled", currentPeriodEnd: at(10) }), db, T0);
    expect(await getEntitlements(w, { db, now: at(9) })).toMatchObject({ plan: "pro", accessEndsAt: at(10) });
    expect(await getEntitlements(w, { db, now: at(10) })).toMatchObject({ plan: "free", source: "free" });
  });
});

describe("daily write-back", () => {
  it("stores Free for subscriptions whose paid access has ended and reports them", async () => {
    const lapsed = await workspace("a@example.com");
    const canceled = await workspace("b@example.com");
    const inGrace = await workspace("c@example.com");
    const live = await workspace("d@example.com");
    await applyBillingEvent("mock", event(lapsed, { status: "past_due" }), db, T0);
    await applyBillingEvent("mock", event(canceled, { status: "canceled", currentPeriodEnd: at(5) }), db, T0);
    await applyBillingEvent("mock", event(inGrace, { status: "past_due" }), db, at(4));
    await applyBillingEvent("mock", event(live), db, T0);

    const now = at(8);
    const changed = await expireSubscriptions(db, now);

    expect(changed.sort()).toEqual([lapsed, canceled].sort());
    expect((await stored(lapsed)).plan).toBe("free");
    expect((await stored(canceled)).plan).toBe("free");
    expect((await stored(inGrace)).plan).toBe("pro");
    expect((await stored(live)).plan).toBe("pro");
    expect(await expireSubscriptions(db, now)).toEqual([]);
  });

  it("leaves a workspace alone while a plan override is in force", async () => {
    const w = await workspace();
    await applyBillingEvent("mock", event(w, { status: "canceled", currentPeriodEnd: at(1) }), db, T0);
    await setPlan(db, w, "team");
    expect(await expireSubscriptions(db, at(5))).toEqual([w]);
    expect(await getEntitlements(w, { db, now: at(5) })).toMatchObject({ plan: "team", source: "override" });
  });

  it("paying again after the write-back restores the paid plan", async () => {
    const w = await workspace();
    await applyBillingEvent("mock", event(w, { status: "canceled", currentPeriodEnd: at(1) }), db, T0);
    await expireSubscriptions(db, at(5));
    await applyBillingEvent("mock", event(w, { currentPeriodEnd: at(35) }), db, at(5));
    expect(await getEntitlements(w, { db, now: at(6) })).toMatchObject({ plan: "pro", source: "subscription" });
  });
});
