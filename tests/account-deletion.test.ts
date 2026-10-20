// @vitest-environment node
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, events, memberships, subscriptions, templates, users } from "@/db/schema";
import { accountDeletionOutcome } from "@/lib/account-deletion";
import { hashPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth/session";
import { BillingProviderError } from "@/lib/billing";
import { MockBillingProvider } from "@/lib/billing/mock";
import { getRateLimitStore } from "@/lib/rate-limit";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";
import { seedFullEvent } from "./helpers/seed-event";

const { db, pool } = createTestDb();
const PASSWORD = "correct horse battery";

let route: typeof import("@/app/api/auth/account/route");
let passwordHash: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  route = await import("@/app/api/auth/account/route");
  passwordHash = await hashPassword(PASSWORD);
});
beforeEach(async () => {
  vi.stubEnv("BILLING_PROVIDER", "mock");
  vi.stubEnv("BILLING_WEBHOOK_SECRET", "whsec-test-secret");
  getRateLimitStore().reset();
  await truncateAll(db);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => pool.end());


async function makeUser(email: string) {
  const [user] = await db.insert(users).values({ email, passwordHash, emailVerifiedAt: new Date() }).returning();
  const workspace = await createPersonalWorkspace(db, user);
  return { user, workspaceId: workspace.id, cookie: `${SESSION_COOKIE}=${createSessionToken(user.id)}` };
}

async function join(workspaceId: string, userId: string, role: "owner" | "admin" | "editor", status: "active" | "suspended" = "active") {
  await db.insert(memberships).values({ workspaceId, userId, role, status });
}

const remove = (cookie: string, body: unknown = { password: PASSWORD }) =>
  route.DELETE(
    new Request("http://localhost/api/auth/account", {
      method: "DELETE",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), "x-real-ip": "203.0.113.9" },
      body: JSON.stringify(body),
    }),
  );

const count = async (table: string, where = sql`true`) => {
  const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(`"${table}"`)} where ${where}`);
  return rows[0].n;
};

describe("accountDeletionOutcome", () => {
  const row = (userId: string, role: string, status = "active") => ({ userId, role, status });

  it("deletes a workspace the person alone belongs to", () => {
    expect(accountDeletionOutcome([row("me", "owner")], "me")).toBe("delete");
  });
  it("blocks the last active owner of a workspace with other members", () => {
    expect(accountDeletionOutcome([row("me", "owner"), row("a", "editor")], "me")).toBe("blocked");
    expect(accountDeletionOutcome([row("me", "owner"), row("a", "owner", "suspended")], "me")).toBe("blocked");
    expect(accountDeletionOutcome([row("me", "owner"), row("a", "viewer", "suspended")], "me")).toBe("blocked");
  });
  it("lets an owner leave once another active owner exists", () => {
    expect(accountDeletionOutcome([row("me", "owner"), row("a", "owner")], "me")).toBe("leave");
  });
  it("lets everyone who is not the last owner leave", () => {
    expect(accountDeletionOutcome([row("o", "owner"), row("me", "admin")], "me")).toBe("leave");
    expect(accountDeletionOutcome([row("o", "owner"), row("me", "editor", "suspended")], "me")).toBe("leave");
  });
});

describe("DELETE /api/auth/account", () => {
  it("needs a session and the right password", async () => {
    const me = await makeUser("me@example.com");
    expect((await remove("")).status).toBe(401);
    for (const body of [{}, { password: "" }, { password: "nope nope nope" }, { password: 12 }]) {
      const res = await remove(me.cookie, body);
      expect(res.status).toBe(400);
    }
    expect(await count("users")).toBe(1);
  });

  it("is rate limited per account", async () => {
    const me = await makeUser("me@example.com");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await remove(me.cookie, { password: "wrong password" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(await count("users")).toBe(1);
  });

  it("refuses the last owner of a workspace with other members, naming the workspace", async () => {
    const me = await makeUser("me@example.com");
    const colleague = await makeUser("colleague@example.com");
    await join(me.workspaceId, colleague.user.id, "editor");

    const res = await remove(me.cookie);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("sole_owner");
    expect(body.workspaces).toEqual([{ id: me.workspaceId, name: "me" }]);
    expect(await count("users", sql`id = ${me.user.id}`)).toBe(1);
    expect(await count("workspaces")).toBe(2);
  });

  it("works after ownership is transferred", async () => {
    const me = await makeUser("me@example.com");
    const colleague = await makeUser("colleague@example.com");
    await join(me.workspaceId, colleague.user.id, "editor");
    expect((await remove(me.cookie)).status).toBe(409);

    await db.update(memberships).set({ role: "owner" }).where(eq(memberships.userId, colleague.user.id));
    const res = await remove(me.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/session=;/);
    expect(await count("users", sql`id = ${me.user.id}`)).toBe(0);
  });

  it("ends memberships but keeps what the person created in the workspace", async () => {
    const owner = await makeUser("owner@example.com");
    const me = await makeUser("me@example.com");
    await join(owner.workspaceId, me.user.id, "editor");
    const { event } = await seedFullEvent(db, owner.workspaceId, me.user.id);
    await db.update(events).set({ ownerId: me.user.id, createdBy: me.user.id }).where(eq(events.id, event.id));
    await db.insert(templates).values({ workspaceId: owner.workspaceId, name: "Kickoff", kind: "event", createdBy: me.user.id });

    const res = await remove(me.cookie);
    expect(res.status).toBe(200);

    expect(await count("memberships", sql`user_id = ${me.user.id}`)).toBe(0);
    const [kept] = await db.select().from(events).where(eq(events.id, event.id));
    expect(kept).toMatchObject({ ownerId: null, createdBy: null, workspaceId: owner.workspaceId });
    expect(await count("interactions")).toBeGreaterThan(0);
    expect(await count("questions")).toBeGreaterThan(0);
    expect(await count("templates", sql`workspace_id = ${owner.workspaceId} and created_by is null`)).toBe(1);
    // The workspace they left and its other members are untouched.
    expect(await count("workspaces", sql`id = ${owner.workspaceId}`)).toBe(1);
    expect(await count("memberships", sql`workspace_id = ${owner.workspaceId}`)).toBe(1);
    // The workspace that left behind a record names the person only by the label of an ordinary entry.
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "auth.account_deleted"));
    expect(entry).toMatchObject({ workspaceId: owner.workspaceId, actorLabel: "me@example.com", targetId: me.user.id });
  });

  it("deletes a workspace the person alone belongs to, with its data, and cancels its subscription once", async () => {
    const me = await makeUser("me@example.com");
    await db.insert(subscriptions).values({
      workspaceId: me.workspaceId,
      plan: "team",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      provider: "mock",
      providerCustomerId: "mock_cus_1",
      providerSubscriptionId: "mock_sub_1",
    });
    await seedFullEvent(db, me.workspaceId, me.user.id);
    const cancel = vi.spyOn(MockBillingProvider.prototype, "cancelSubscription");

    const res = await remove(me.cookie);
    expect(res.status).toBe(200);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await count("users")).toBe(0);
    expect(await count("workspaces")).toBe(0);
    expect(await count("events")).toBe(0);
    expect(await count("subscriptions")).toBe(0);
    const kept = await db.execute<{ id: string; plan: string }>(sql`select id, plan from deleted_workspaces`);
    expect(kept.rows).toEqual([{ id: me.workspaceId, plan: "team" }]);
  });

  it("changes nothing when the provider cannot cancel a workspace that would go with the account", async () => {
    const me = await makeUser("me@example.com");
    await db.insert(subscriptions).values({
      workspaceId: me.workspaceId,
      plan: "pro",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      provider: "mock",
      providerCustomerId: "mock_cus_1",
      providerSubscriptionId: "mock_sub_1",
    });
    vi.spyOn(MockBillingProvider.prototype, "cancelSubscription").mockRejectedValue(new BillingProviderError("down", 500));

    expect((await remove(me.cookie)).status).toBe(502);
    expect(await count("users")).toBe(1);
    expect(await count("workspaces")).toBe(1);
  });

  it("does not need billing for a free workspace", async () => {
    const me = await makeUser("me@example.com");
    await setPlan(db, me.workspaceId, "pro");
    vi.stubEnv("BILLING_PROVIDER", "");
    vi.stubEnv("NODE_ENV", "production");
    const res = await remove(me.cookie);
    expect(res.status).toBe(200);
    expect(await count("users")).toBe(0);
  });
});
