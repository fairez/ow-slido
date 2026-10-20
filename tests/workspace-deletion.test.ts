// @vitest-environment node
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditLog,
  authTokens,
  billingEvents,
  deletedWorkspaces,
  events,
  invitations,
  memberships,
  subscriptions,
  templateItems,
  templates,
  users,
  workspaceExports,
  workspaces,
} from "@/db/schema";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth/session";
import { BillingProviderError } from "@/lib/billing";
import { MockBillingProvider } from "@/lib/billing/mock";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";
import { seedFullEvent } from "./helpers/seed-event";

const { db, pool } = createTestDb();

let route: typeof import("@/app/api/workspaces/active/route");

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  route = await import("@/app/api/workspaces/active/route");
});
beforeEach(async () => {
  vi.stubEnv("BILLING_PROVIDER", "mock");
  vi.stubEnv("BILLING_WEBHOOK_SECRET", "whsec-test-secret");
  await truncateAll(db);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => pool.end());

async function makeUser(email: string) {
  const [user] = await db.insert(users).values({ email, passwordHash: "x", emailVerifiedAt: new Date() }).returning();
  const workspace = await createPersonalWorkspace(db, user);
  return { user, workspaceId: workspace.id, cookie: `${SESSION_COOKIE}=${createSessionToken(user.id)}` };
}

async function addMember(workspaceId: string, email: string, role: "owner" | "admin" | "editor") {
  const [user] = await db.insert(users).values({ email, passwordHash: "x", emailVerifiedAt: new Date() }).returning();
  await db.insert(memberships).values({ workspaceId, userId: user.id, role });
  return { user, cookie: `${SESSION_COOKIE}=${createSessionToken(user.id)}` };
}

const remove = (cookie: string, body: unknown, workspaceId?: string) =>
  route.DELETE(
    new Request("http://localhost/api/workspaces/active", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: workspaceId ? `${cookie}; workspace=${workspaceId}` : cookie, "x-real-ip": "203.0.113.5" },
      body: JSON.stringify(body),
    }),
  );

async function paidSubscription(workspaceId: string) {
  await db.insert(subscriptions).values({
    workspaceId,
    plan: "pro",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
    provider: "mock",
    providerCustomerId: "mock_cus_1",
    providerSubscriptionId: "mock_sub_1",
  });
}

const count = async (table: string, where = sql`true`) => {
  const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(`"${table}"`)} where ${where}`);
  return rows[0].n;
};

describe("DELETE /api/workspaces/active", () => {
  it("only an owner may delete, and the name must match", async () => {
    const owner = await makeUser("owner@example.com");
    const admin = await addMember(owner.workspaceId, "admin@example.com", "admin");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, owner.workspaceId));

    expect((await remove(admin.cookie, { name: ws.name }, owner.workspaceId)).status).toBe(403);
    expect((await remove("", { name: ws.name })).status).toBe(401);
    for (const body of [{}, { name: "" }, { name: "something else" }, { name: 5 }]) {
      const res = await remove(owner.cookie, body);
      expect(res.status).toBe(400);
      expect((await res.json()).reason).toBe("name_mismatch");
    }
    expect(await count("workspaces", sql`id = ${owner.workspaceId}`)).toBe(1);
    expect(await count("deleted_workspaces")).toBe(0);
  });

  it("deletes after the typed name (trimmed), keeps one content-free record and cancels billing once", async () => {
    const owner = await makeUser("owner@example.com");
    await paidSubscription(owner.workspaceId);
    const cancel = vi.spyOn(MockBillingProvider.prototype, "cancelSubscription");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, owner.workspaceId));

    const res = await remove(owner.cookie, { name: `  ${ws.name}  ` });
    expect(res.status).toBe(200);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][0]).toMatchObject({ workspaceId: owner.workspaceId, providerSubscriptionId: "mock_sub_1" });
    expect(await count("workspaces", sql`id = ${owner.workspaceId}`)).toBe(0);
    const kept = await db.select().from(deletedWorkspaces);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: owner.workspaceId, plan: "pro" });
    expect(Object.keys(kept[0]).sort()).toEqual(["deletedAt", "id", "plan"]);
  });

  it("does not call the provider for a workspace without a paid subscription", async () => {
    const owner = await makeUser("owner@example.com");
    await setPlan(db, owner.workspaceId, "team");
    const cancel = vi.spyOn(MockBillingProvider.prototype, "cancelSubscription");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, owner.workspaceId));
    expect((await remove(owner.cookie, { name: ws.name })).status).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
    expect((await db.select().from(deletedWorkspaces))[0].plan).toBe("team");
  });

  it("deletes nothing when the provider refuses to cancel", async () => {
    const owner = await makeUser("owner@example.com");
    await paidSubscription(owner.workspaceId);
    await seedFullEvent(db, owner.workspaceId, owner.user.id);
    vi.spyOn(MockBillingProvider.prototype, "cancelSubscription").mockRejectedValue(new BillingProviderError("down", 500));
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, owner.workspaceId));

    const res = await remove(owner.cookie, { name: ws.name });
    expect(res.status).toBe(502);
    expect(await count("workspaces", sql`id = ${owner.workspaceId}`)).toBe(1);
    expect(await count("events")).toBe(1);
    expect(await count("deleted_workspaces")).toBe(0);
  });

  it("deletes nothing when the subscription belongs to a provider that is not active", async () => {
    const owner = await makeUser("owner@example.com");
    await paidSubscription(owner.workspaceId);
    await db.update(subscriptions).set({ provider: "stripe" }).where(eq(subscriptions.workspaceId, owner.workspaceId));
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, owner.workspaceId));
    expect((await remove(owner.cookie, { name: ws.name })).status).toBe(503);
    expect(await count("workspaces", sql`id = ${owner.workspaceId}`)).toBe(1);
  });

  it("leaves other workspaces alone and gives members who lose their only workspace a personal one", async () => {
    const owner = await makeUser("owner@example.com");
    const other = await makeUser("other@example.com");
    const stranded = await addMember(owner.workspaceId, "stranded@example.com", "editor");
    const hasOther = await addMember(owner.workspaceId, "has-other@example.com", "editor");
    await db.insert(memberships).values({ workspaceId: other.workspaceId, userId: hasOther.user.id, role: "viewer" });
    await seedFullEvent(db, other.workspaceId, other.user.id);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, owner.workspaceId));

    expect((await remove(owner.cookie, { name: ws.name })).status).toBe(200);

    expect(await count("workspaces", sql`id = ${other.workspaceId}`)).toBe(1);
    expect(await count("events", sql`workspace_id = ${other.workspaceId}`)).toBe(1);
    for (const person of [owner, stranded]) {
      const rows = await db.select().from(memberships).where(eq(memberships.userId, person.user.id));
      expect(rows, person.user.email).toHaveLength(1);
      expect(rows[0]).toMatchObject({ role: "owner", status: "active" });
      expect(rows[0].workspaceId).not.toBe(owner.workspaceId);
    }
    expect(await db.select().from(memberships).where(eq(memberships.userId, hasOther.user.id))).toHaveLength(1);
    expect(await count("users")).toBe(4);
  });

  it("removes every table below workspaces by cascade", async () => {
    const owner = await makeUser("owner@example.com");
    await addMember(owner.workspaceId, "editor@example.com", "editor");
    await paidSubscription(owner.workspaceId);
    await seedFullEvent(db, owner.workspaceId, owner.user.id);
    const [tpl] = await db.insert(templates).values({ workspaceId: owner.workspaceId, name: "Kickoff", kind: "interaction", createdBy: owner.user.id }).returning();
    await db.insert(templateItems).values({ templateId: tpl.id, position: 0, type: "poll", title: "Lunch?", config: { prompt: "Lunch?" } });
    const [token] = await db
      .insert(authTokens)
      .values({ purpose: "invite", tokenHash: "hash-1", expiresAt: new Date(Date.now() + 86_400_000) })
      .returning();
    await db.insert(invitations).values({ workspaceId: owner.workspaceId, email: "new@example.com", role: "viewer", tokenId: token.id, expiresAt: new Date(Date.now() + 86_400_000) });
    await db.insert(billingEvents).values({ provider: "mock", providerEventId: "evt_1", workspaceId: owner.workspaceId, type: "subscription.updated" });
    await db.insert(workspaceExports).values({ workspaceId: owner.workspaceId, status: "failed", error: "interrupted" });
    await db.insert(auditLog).values({ workspaceId: owner.workspaceId, actorLabel: "owner@example.com", action: "member.added" });

    // Every table that reaches `workspaces` through foreign keys, however many hops away.
    const { rows: fks } = await db.execute<{ child: string; parent: string; rule: string }>(sql`
      select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, c.confdeltype::text as rule
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname = 'public'`);
    const reached = new Set<string>();
    const queue = ["workspaces"];
    while (queue.length) {
      const parent = queue.pop()!;
      for (const fk of fks) {
        if (fk.parent === parent && !reached.has(fk.child)) {
          reached.add(fk.child);
          queue.push(fk.child);
        }
      }
    }
    // The AI call counter keeps its row (event set to null) so deleting events cannot reset the daily cap.
    const kept = ["ai_calls"];
    const tables = [...reached].filter((t) => !kept.includes(t)).sort();
    expect(tables).toEqual(expect.arrayContaining(["events", "interactions", "memberships", "templates", "template_items", "invitations", "subscriptions", "billing_events", "audit_log", "workspace_exports", "quiz_scores", "survey_answers"]));
    for (const table of tables) expect(await count(table), `${table} seeded`).toBeGreaterThan(0);

    const inTree = new Set(["workspaces", ...reached]);
    for (const fk of fks.filter((f) => inTree.has(f.child) && inTree.has(f.parent) && !kept.includes(f.child))) {
      expect(fk.rule, `${fk.child} -> ${fk.parent}`).toBe("c");
    }

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, owner.workspaceId));
    expect((await remove(owner.cookie, { name: ws.name })).status).toBe(200);

    // The owner is given a fresh personal workspace, which has no data of its own.
    for (const table of tables.filter((t) => !["memberships", "audit_log"].includes(t))) {
      expect(await count(table), `${table} emptied`).toBe(0);
    }
    expect(await count("memberships", sql`workspace_id = ${owner.workspaceId}`)).toBe(0);
    expect(await count("audit_log", sql`workspace_id = ${owner.workspaceId}`)).toBe(0);
    expect(await count("deleted_workspaces")).toBe(1);
    expect(await db.select().from(events)).toHaveLength(0);
  });
});
