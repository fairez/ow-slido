// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, memberships, users, workspaces } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken } from "@/lib/auth/session";
import { brandingLock } from "@/lib/plan-hints";
import { PLANS } from "@/lib/plans";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request) => Promise<Response>;
let get: Handler;
let patch: Handler;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  ({ GET: get, PATCH: patch } = await import("@/app/api/workspaces/active/branding/route"));
});
beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

const request = (method: string, cookie: string | undefined, body?: unknown) =>
  new Request("http://localhost/api/workspaces/active/branding", {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function person(email: string, workspaceId?: string, role: "owner" | "admin" | "editor" = "editor") {
  const [user] = await db.insert(users).values({ email, passwordHash: await hashPassword("correct horse battery"), emailVerifiedAt: new Date() }).returning();
  if (workspaceId) await db.insert(memberships).values({ workspaceId, userId: user.id, role });
  else workspaceId = (await createPersonalWorkspace(db, user)).id;
  return { user, workspaceId, cookie: `session=${createSessionToken(user.id)}` };
}

const stored = async (workspaceId: string) => (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0].brandAccent;

describe("/api/workspaces/active/branding", () => {
  it("needs a session and branding.manage", async () => {
    const owner = await person("owner@example.com");
    await setPlan(db, owner.workspaceId, "team");
    const editor = await person("editor@example.com", owner.workspaceId);
    expect((await patch(request("PATCH", undefined, { accent: "#1f6f5c" }))).status).toBe(401);
    expect((await patch(request("PATCH", editor.cookie, { accent: "#1f6f5c" }))).status).toBe(403);
    expect((await get(request("GET", editor.cookie))).status).toBe(403);
    expect(await stored(owner.workspaceId)).toBeNull();
  });

  it("answers 402 with the tier on Free and Pro and stores nothing", async () => {
    const owner = await person("owner@example.com");
    for (const plan of ["free", "pro"] as const) {
      await setPlan(db, owner.workspaceId, plan);
      const res = await patch(request("PATCH", owner.cookie, { accent: "#1f6f5c" }));
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ reason: "branding", requiredPlan: "team" });
    }
    expect(await stored(owner.workspaceId)).toBeNull();
  });

  it("stores a passing colour as lowercase #rrggbb, audits it, and reads it back", async () => {
    const owner = await person("owner@example.com");
    await setPlan(db, owner.workspaceId, "team");
    const res = await patch(request("PATCH", owner.cookie, { accent: "#1F6F5C" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accent: "#1f6f5c" });
    expect(await stored(owner.workspaceId)).toBe("#1f6f5c");
    expect(await (await get(request("GET", owner.cookie))).json()).toEqual({ accent: "#1f6f5c" });
    const entries = await db.select().from(auditLog).where(eq(auditLog.workspaceId, owner.workspaceId));
    expect(entries.map((e) => e.metadata)).toContainEqual({ setting: "brand_accent", from: null, to: "#1f6f5c" });
  });

  it("rejects a failing colour with 422 naming the pair, and keeps the old one", async () => {
    const owner = await person("owner@example.com");
    await setPlan(db, owner.workspaceId, "team");
    await patch(request("PATCH", owner.cookie, { accent: "#1f6f5c" }));
    const res = await patch(request("PATCH", owner.cookie, { accent: "#f4d35e" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.reason).toBe("contrast_failed");
    expect(body.error).toContain("#f4d35e");
    expect(body.error).toMatch(/accent on the page background|accent on cards|text on the accent/);
    expect(body.failures[0]).toMatchObject({ theme: "light", ok: false });
    expect(await stored(owner.workspaceId)).toBe("#1f6f5c");
  });

  it("rejects malformed input with 400", async () => {
    const owner = await person("owner@example.com");
    await setPlan(db, owner.workspaceId, "team");
    const bad = await patch(request("PATCH", owner.cookie, { accent: "teal" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).reason).toBe("invalid_colour");
    expect((await patch(request("PATCH", owner.cookie, { accent: 5 }))).status).toBe(400);
    expect((await patch(request("PATCH", owner.cookie, {}))).status).toBe(400);
  });

  it("removes the colour even after a downgrade, and audits the change once", async () => {
    const owner = await person("owner@example.com");
    await setPlan(db, owner.workspaceId, "team");
    await patch(request("PATCH", owner.cookie, { accent: "#1f6f5c" }));
    await setPlan(db, owner.workspaceId, "free");
    expect((await patch(request("PATCH", owner.cookie, { accent: null }))).status).toBe(200);
    expect(await stored(owner.workspaceId)).toBeNull();
    // removing again changes nothing, so no second entry
    await patch(request("PATCH", owner.cookie, { accent: null }));
    const entries = await db.select().from(auditLog).where(eq(auditLog.workspaceId, owner.workspaceId));
    expect(entries.filter((e) => (e.metadata as { to?: unknown }).to === null)).toHaveLength(1);
  });

  it("the database refuses a value that is not lowercase #rrggbb", async () => {
    const owner = await person("owner@example.com");
    await expect(db.update(workspaces).set({ brandAccent: "red" }).where(eq(workspaces.id, owner.workspaceId))).rejects.toThrow();
  });
});

describe("brandingLock", () => {
  it("points Free and Pro at Team and is empty for Team", () => {
    expect(brandingLock(PLANS.free)).toEqual({ requiredPlan: "team" });
    expect(brandingLock(PLANS.pro)).toEqual({ requiredPlan: "team" });
    expect(brandingLock(PLANS.team)).toBeUndefined();
  });
});
