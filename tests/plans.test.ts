// @vitest-environment node
import { readdirSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { subscriptions, workspaces } from "@/db/schema";
import {
  getEntitlements,
  PAST_DUE_GRACE_DAYS,
  PLAN_PRICES,
  PLANS,
  resolveEntitlements,
  utcMonthBounds,
  type SubscriptionRow,
} from "@/lib/plans";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();
afterAll(() => pool.end());
beforeEach(() => truncateAll(db));

const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * DAY);

function row(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "s1",
    workspaceId: "w1",
    plan: "pro",
    status: "active",
    interval: "month",
    currentPeriodEnd: daysFromNow(10),
    provider: null,
    providerCustomerId: null,
    providerSubscriptionId: null,
    planOverride: null,
    planOverrideUntil: null,
    planOverrideReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("plan definitions", () => {
  it("Free: one seat, 100 participants, basic types, no AI, CSV only", () => {
    const f = PLANS.free;
    expect(f.seats).toBe(1);
    expect(f.participantsPerEvent).toBe(100);
    expect([...f.allowedTypes].sort()).toEqual(["openText", "poll", "qa", "rating", "sharedNotes", "wordcloud"]);
    expect(f.aiCallsPerEvent).toBe(0);
    expect(f.aiCallsPerMonth).toBe(0);
    expect(f.reportFormats).toEqual(["csv"]);
    expect(f.branding || f.auditLog || f.enforced2fa).toBe(false);
  });

  it("Pro: three seats, 1000 participants, every type, AI, PDF and Excel", () => {
    const p = PLANS.pro;
    expect(p.seats).toBe(3);
    expect(p.participantsPerEvent).toBe(1000);
    expect(p.allowedTypes).toEqual(expect.arrayContaining(["ranking", "quiz", "survey", "qa", "poll"]));
    expect(p.aiCallsPerEvent).toBeGreaterThan(0);
    expect(p.aiCallsPerMonth).toBeGreaterThan(0);
    expect(p.reportFormats).toEqual(["csv", "pdf", "xlsx"]);
    expect(p.branding || p.auditLog || p.enforced2fa).toBe(false);
  });

  it("Team: 15 seats, 5000 participants, branding, audit log and 2FA enforcement", () => {
    const t = PLANS.team;
    expect(t.seats).toBe(15);
    expect(t.participantsPerEvent).toBe(5000);
    expect([t.branding, t.auditLog, t.enforced2fa]).toEqual([true, true, true]);
    expect(t.allowedTypes).toEqual(PLANS.pro.allowedTypes);
  });

  it("states prices as integer minor units with an ISO currency", () => {
    for (const price of Object.values(PLAN_PRICES)) {
      expect(price.currency).toMatch(/^[A-Z]{3}$/);
      expect(Number.isInteger(price.month)).toBe(true);
      expect(Number.isInteger(price.year)).toBe(true);
      expect(price.year).toBeLessThan(price.month * 12);
    }
    expect(PLAN_PRICES.team.month).toBeGreaterThan(PLAN_PRICES.pro.month);
  });
});

describe("resolveEntitlements", () => {
  it("is Free without a subscription row", () => {
    const e = resolveEntitlements(null, NOW);
    expect(e).toMatchObject({ plan: "free", source: "free", status: null });
    expect(e.limits).toBe(PLANS.free);
  });

  it.each(["pro", "team"] as const)("gives %s limits while active or trialing", (plan) => {
    for (const status of ["active", "trialing"] as const) {
      const e = resolveEntitlements(row({ plan, status }), NOW);
      expect(e).toMatchObject({ plan, source: "subscription", status, graceEndsAt: null });
      expect(e.limits).toBe(PLANS[plan]);
    }
  });

  it("keeps a canceled plan until the period ends, then falls back to Free", () => {
    const during = resolveEntitlements(row({ status: "canceled", currentPeriodEnd: daysFromNow(3) }), NOW);
    expect(during).toMatchObject({ plan: "pro", accessEndsAt: daysFromNow(3) });
    const after = resolveEntitlements(row({ status: "canceled", currentPeriodEnd: daysFromNow(-1) }), NOW);
    expect(after).toMatchObject({ plan: "free", source: "free", status: "canceled" });
    expect(resolveEntitlements(row({ status: "canceled", currentPeriodEnd: null }), NOW).plan).toBe("free");
  });

  it("keeps a past_due plan through the grace period, then falls back to Free", () => {
    const periodEnd = daysFromNow(-(PAST_DUE_GRACE_DAYS - 1));
    const within = resolveEntitlements(row({ status: "past_due", currentPeriodEnd: periodEnd }), NOW);
    expect(within.plan).toBe("pro");
    expect(within.graceEndsAt).toEqual(new Date(periodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY));

    const over = resolveEntitlements(
      row({ status: "past_due", currentPeriodEnd: daysFromNow(-(PAST_DUE_GRACE_DAYS + 1)) }),
      NOW,
    );
    expect(over).toMatchObject({ plan: "free", source: "free", graceEndsAt: null });
  });

  it("an override replaces the paid plan, with or without a stored subscription", () => {
    const e = resolveEntitlements(row({ plan: "free", planOverride: "team", planOverrideReason: "partner" }), NOW);
    expect(e).toMatchObject({ plan: "team", source: "override" });
    const lower = resolveEntitlements(row({ plan: "team", planOverride: "free" }), NOW);
    expect(lower).toMatchObject({ plan: "free", source: "override" });
  });

  it("an override applies until its end and not after", () => {
    const base = { plan: "free", planOverride: "pro", planOverrideReason: "trial" } as const;
    expect(resolveEntitlements(row({ ...base, planOverrideUntil: daysFromNow(1) }), NOW).plan).toBe("pro");
    const expired = resolveEntitlements(row({ ...base, planOverrideUntil: daysFromNow(-1) }), NOW);
    expect(expired).toMatchObject({ plan: "free", source: "free" });
    expect(resolveEntitlements(row({ ...base, planOverrideUntil: NOW }), NOW).plan).toBe("free");
  });

  it("an expired override falls back to the paid plan", () => {
    const e = resolveEntitlements(
      row({ plan: "team", planOverride: "free", planOverrideUntil: daysFromNow(-1) }),
      NOW,
    );
    expect(e).toMatchObject({ plan: "team", source: "subscription" });
  });
});

describe("getEntitlements", () => {
  it("reads the stored row, and is Free for a workspace without one", async () => {
    const [bare] = await db.insert(workspaces).values({ name: "bare" }).returning();
    expect((await getEntitlements(bare.id, { db, now: NOW })).plan).toBe("free");

    const [paid] = await db.insert(workspaces).values({ name: "paid" }).returning();
    await db
      .insert(subscriptions)
      .values({ workspaceId: paid.id, plan: "team", status: "active", currentPeriodEnd: daysFromNow(20) });
    const e = await getEntitlements(paid.id, { db, now: NOW });
    expect(e).toMatchObject({ plan: "team", source: "subscription", interval: "month" });
    expect(e.limits.seats).toBe(15);
  });

  it("allows one subscription per workspace and cascades with the workspace", async () => {
    const [ws] = await db.insert(workspaces).values({ name: "w" }).returning();
    await db.insert(subscriptions).values({ workspaceId: ws.id });
    await expect(db.insert(subscriptions).values({ workspaceId: ws.id })).rejects.toThrow();
    await expect(db.insert(subscriptions).values({ workspaceId: ws.id, plan: "gold" as "pro" })).rejects.toThrow();
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });
});

describe("utcMonthBounds", () => {
  it("returns the UTC calendar month with an exclusive end", () => {
    expect(utcMonthBounds(new Date("2026-10-20T12:00:00Z"))).toEqual({
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-11-01T00:00:00Z"),
    });
  });

  it("uses UTC even when the local date is another month", () => {
    // 2026-11-30T23:30 in UTC-5 is already 2026-12-01T04:30Z.
    expect(utcMonthBounds(new Date("2026-12-01T04:30:00Z")).start).toEqual(new Date("2026-12-01T00:00:00Z"));
    expect(utcMonthBounds(new Date("2026-11-30T23:59:59.999Z")).end).toEqual(new Date("2026-12-01T00:00:00Z"));
  });

  it("rolls the year over in December", () => {
    expect(utcMonthBounds(new Date("2026-12-15T00:00:00Z")).end).toEqual(new Date("2027-01-01T00:00:00Z"));
  });
});

describe("migration 0027 backfill", () => {
  const schema = "mig_rehearsal_plans";

  it("puts every workspace on Free and grandfathers those with an AI analysis to Pro", async () => {
    const files = readMigrationFiles({ migrationsFolder: path.resolve("db/migrations") });
    const names = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
    const idx = names.findIndex((f) => f.startsWith("0027_"));
    expect(idx).toBeGreaterThan(0);

    const rehearsal = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    const run = async (migration: (typeof files)[number]) => {
      for (const statement of migration.sql) await rehearsal.query(statement.replaceAll('"public".', `"${schema}".`));
    };
    try {
      await rehearsal.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await rehearsal.query(`CREATE SCHEMA ${schema}`);
      for (const m of files.slice(0, idx)) await run(m);

      const u = "00000000-0000-0000-0000-000000000001";
      await rehearsal.query(`insert into users (id, email, password_hash) values ('${u}', 'ana@example.com', 'h')`);
      await rehearsal.query(`insert into workspaces (id, name) values
        ('a0000000-0000-0000-0000-000000000001', 'with-ai'),
        ('a0000000-0000-0000-0000-000000000002', 'plain'),
        ('a0000000-0000-0000-0000-000000000003', 'notes-only'),
        ('a0000000-0000-0000-0000-000000000004', 'empty')`);
      await rehearsal.query(`insert into events (id, owner_id, workspace_id, name, starts_at, ends_at, join_code) values
        ('b0000000-0000-0000-0000-000000000001', '${u}', 'a0000000-0000-0000-0000-000000000001', 'E1', now(), now(), '1111'),
        ('b0000000-0000-0000-0000-000000000002', '${u}', 'a0000000-0000-0000-0000-000000000002', 'E2', now(), now(), '2222'),
        ('b0000000-0000-0000-0000-000000000003', '${u}', 'a0000000-0000-0000-0000-000000000003', 'E3', now(), now(), '3333')`);
      await rehearsal.query(`insert into interactions (id, event_id, type, title, state, position) values
        ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'sharedNotes', 'N1', 'draft', 0),
        ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'poll', 'P2', 'draft', 0),
        ('c0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000003', 'sharedNotes', 'N3', 'draft', 0)`);
      await rehearsal.query(`insert into note_analyses (interaction_id, notes_snapshot_hash, note_count) values
        ('c0000000-0000-0000-0000-000000000001', 'h1', 4),
        ('c0000000-0000-0000-0000-000000000001', 'h2', 5)`);

      await run(files[idx]);

      const rows = await rehearsal.query(
        `select w.name, s.plan, s.status, s.interval, s.plan_override, s.plan_override_until, s.plan_override_reason
         from subscriptions s join workspaces w on w.id = s.workspace_id order by w.name`,
      );
      expect(rows.rows).toEqual([
        { name: "empty", plan: "free", status: "active", interval: "month", plan_override: null, plan_override_until: null, plan_override_reason: null },
        { name: "notes-only", plan: "free", status: "active", interval: "month", plan_override: null, plan_override_until: null, plan_override_reason: null },
        { name: "plain", plan: "free", status: "active", interval: "month", plan_override: null, plan_override_until: null, plan_override_reason: null },
        { name: "with-ai", plan: "free", status: "active", interval: "month", plan_override: "pro", plan_override_until: null, plan_override_reason: "grandfathered" },
      ]);
    } finally {
      await rehearsal.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await rehearsal.end();
    }
  }, 60_000);
});
