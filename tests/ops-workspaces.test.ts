// @vitest-environment node
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  aiCalls,
  events,
  invitations,
  memberships,
  subscriptions,
  users,
  workspaces,
  authTokens,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken } from "@/lib/auth/session";
import { isOperator, operatorEmails } from "@/lib/operator";
import {
  OPS_PAGE_SIZE,
  listOpsWorkspaces,
  parseOpsFilters,
} from "@/lib/ops-workspaces";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();
let list: (req: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  list = (await import("@/app/api/ops/workspaces/route")).GET;
});
beforeEach(async () => {
  await truncateAll(db);
  vi.stubEnv("OPERATOR_EMAILS", "boss@example.com, Second@Example.com");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pool.end();
});

const passwordHash = hashPassword("correct horse battery");
const get = (path: string, cookie?: string) =>
  new Request(`http://localhost${path}`, {
    headers: { "x-real-ip": "10.0.0.4", ...(cookie ? { cookie } : {}) },
  });

async function person(email: string, opts: { verified?: boolean } = {}) {
  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await passwordHash,
      emailVerifiedAt: opts.verified === false ? null : new Date(),
    })
    .returning();
  const workspace = await createPersonalWorkspace(db, user);
  return { user, workspace, cookie: `session=${createSessionToken(user.id)}` };
}

describe("operator flag", () => {
  it("reads the comma list in any case and ignores blanks", () => {
    expect(operatorEmails()).toEqual([
      "boss@example.com",
      "second@example.com",
    ]);
    vi.stubEnv("OPERATOR_EMAILS", "");
    expect(operatorEmails()).toEqual([]);
  });

  it("needs a listed address, a verified email and no pending password change", () => {
    const base = {
      email: "Boss@Example.com",
      emailVerifiedAt: new Date(),
      mustChangePassword: false,
    };
    expect(isOperator(base)).toBe(true);
    expect(isOperator({ ...base, emailVerifiedAt: null })).toBe(false);
    expect(isOperator({ ...base, mustChangePassword: true })).toBe(false);
    expect(isOperator({ ...base, email: "other@example.com" })).toBe(false);
    expect(isOperator(null)).toBe(false);
  });

  it("is nobody when the variable is unset", async () => {
    vi.stubEnv("OPERATOR_EMAILS", "");
    expect(
      isOperator({
        email: "",
        emailVerifiedAt: new Date(),
        mustChangePassword: false,
      }),
    ).toBe(false);
  });
});

describe("GET /api/ops/workspaces access", () => {
  it("lets a verified operator in", async () => {
    const op = await person("boss@example.com");
    const response = await list(get("/api/ops/workspaces", op.cookie));
    expect(response.status).toBe(200);
    expect((await response.json()).total).toBe(1);
  });

  it("answers 404 to anonymous visitors, members and an unverified operator email", async () => {
    const member = await person("member@example.com");
    const unverified = await person("second@example.com", { verified: false });
    const bodies: unknown[] = [];
    for (const cookie of [undefined, member.cookie, unverified.cookie]) {
      const response = await list(get("/api/ops/workspaces", cookie));
      expect(response.status).toBe(404);
      bodies.push(await response.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("answers 404 for a garbage session token", async () => {
    expect(
      (await list(get("/api/ops/workspaces", "session=bad.token"))).status,
    ).toBe(404);
  });

  it("rejects a bad page with 400 for the operator", async () => {
    const op = await person("boss@example.com");
    expect(
      (await list(get("/api/ops/workspaces?page=0", op.cookie))).status,
    ).toBe(400);
  });
});

describe("listOpsWorkspaces", () => {
  const now = new Date("2026-10-15T12:00:00Z");

  it("reports plan, status, seats, members, events and AI calls for the month", async () => {
    const owner = await person("owner@acme.test");
    const wid = owner.workspace.id;
    await setPlan(db, wid, "pro");
    await db
      .update(subscriptions)
      .set({
        status: "past_due",
        pastDueSince: new Date("2026-10-10T00:00:00Z"),
        plan: "pro",
      })
      .where(eq(subscriptions.workspaceId, wid));
    const helper = await person("helper@acme.test");
    await db
      .insert(memberships)
      .values({ workspaceId: wid, userId: helper.user.id, role: "editor" });
    const [token] = await db
      .insert(authTokens)
      .values({
        userId: owner.user.id,
        purpose: "invite",
        tokenHash: "h",
        expiresAt: new Date("2026-12-01"),
      })
      .returning();
    await db
      .insert(invitations)
      .values([
        {
          workspaceId: wid,
          email: "new@acme.test",
          role: "viewer",
          tokenId: token.id,
          expiresAt: new Date("2026-12-01"),
        },
      ]);
    const [thisMonth, lastMonth] = await db
      .insert(events)
      .values([
        {
          workspaceId: wid,
          ownerId: owner.user.id,
          name: "Now",
          joinCode: "100001",
          startsAt: new Date("2026-10-02"),
          endsAt: new Date("2026-10-03"),
          createdAt: new Date("2026-10-02T00:00:00Z"),
        },
        {
          workspaceId: wid,
          ownerId: owner.user.id,
          name: "Old",
          joinCode: "100002",
          startsAt: new Date("2026-09-30"),
          endsAt: new Date("2026-10-01"),
          createdAt: new Date("2026-09-30T23:59:00Z"),
        },
      ])
      .returning();
    await db.insert(aiCalls).values([
      {
        eventId: thisMonth.id,
        kind: "analysis",
        provider: "mock",
        model: "m",
        createdAt: new Date("2026-10-03T00:00:00Z"),
      },
      {
        eventId: thisMonth.id,
        kind: "analysis",
        provider: "mock",
        model: "m",
        createdAt: new Date("2026-10-04T00:00:00Z"),
      },
      {
        eventId: lastMonth.id,
        kind: "analysis",
        provider: "mock",
        model: "m",
        createdAt: new Date("2026-09-30T00:00:00Z"),
      },
    ]);

    const page = await listOpsWorkspaces(db, { q: "acme" }, now);
    const row = page.workspaces.find((w) => w.id === wid)!;
    expect(row).toMatchObject({
      name: "owner",
      plan: "pro",
      status: "past_due",
      members: 2,
      seatsUsed: 3,
      eventsThisMonth: 1,
      aiCallsThisMonth: 2,
      ownerEmail: "owner@acme.test",
    });
  });

  it("shows Free with no status for a workspace that never had a subscription", async () => {
    const owner = await person("solo@example.com");
    const [row] = (await listOpsWorkspaces(db)).workspaces;
    expect(row).toMatchObject({
      id: owner.workspace.id,
      plan: "free",
      status: null,
      members: 1,
      seatsUsed: 1,
      eventsThisMonth: 0,
      aiCallsThisMonth: 0,
    });
  });

  it("searches by workspace name or owner email, literally and in any case", async () => {
    const a = await person("ana@alpha.test");
    const b = await person("bob@beta.test");
    await db
      .update(workspaces)
      .set({ name: "Alpha 100%" })
      .where(eq(workspaces.id, a.workspace.id));
    expect(
      (await listOpsWorkspaces(db, { q: "ALPHA 100%" })).workspaces.map(
        (w) => w.id,
      ),
    ).toEqual([a.workspace.id]);
    expect(
      (await listOpsWorkspaces(db, { q: "bob@BETA" })).workspaces.map(
        (w) => w.id,
      ),
    ).toEqual([b.workspace.id]);
    expect((await listOpsWorkspaces(db, { q: "%" })).total).toBe(1);
    expect((await listOpsWorkspaces(db, { q: "nothing" })).total).toBe(0);
  });

  it("does not match a search on the email of a non-owner member", async () => {
    const owner = await person("owner@gamma.test");
    const other = await person("viewer@delta.test");
    await db
      .insert(memberships)
      .values({
        workspaceId: owner.workspace.id,
        userId: other.user.id,
        role: "viewer",
      });
    const found = await listOpsWorkspaces(db, { q: "delta.test" });
    expect(found.workspaces.map((w) => w.id)).toEqual([other.workspace.id]);
  });

  it("pages by the page size, newest workspace first", async () => {
    const rows = Array.from({ length: OPS_PAGE_SIZE + 3 }, (_, i) => ({
      name: `W${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    }));
    await db.insert(workspaces).values(rows);
    const first = await listOpsWorkspaces(db);
    expect(first).toMatchObject({
      total: OPS_PAGE_SIZE + 3,
      page: 1,
      pageSize: OPS_PAGE_SIZE,
    });
    expect(first.workspaces).toHaveLength(OPS_PAGE_SIZE);
    expect(first.workspaces[0].name).toBe(`W${OPS_PAGE_SIZE + 2}`);
    const second = await listOpsWorkspaces(db, { page: 2 });
    expect(second.workspaces.map((w) => w.name)).toEqual(["W2", "W1", "W0"]);
    expect(second.workspaces[0].ownerEmail).toBeNull();
  });
});

describe("parseOpsFilters", () => {
  it("trims the search and rejects a bad page", () => {
    expect(parseOpsFilters(new URLSearchParams("q=%20acme%20&page=2"))).toEqual(
      { ok: true, value: { q: "acme", page: 2 } },
    );
    expect(parseOpsFilters(new URLSearchParams("page=1.5"))).toEqual({
      ok: false,
      error: "page",
    });
    expect(parseOpsFilters(new URLSearchParams(""))).toEqual({
      ok: true,
      value: {},
    });
  });
});
