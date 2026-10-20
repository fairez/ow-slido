// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, memberships, users, workspaces } from "@/db/schema";
import { AUDIT_PAGE_SIZE, listAuditActions, listAuditEntries, parseAuditFilters } from "@/lib/audit-query";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken } from "@/lib/auth/session";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();
let list: (req: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  list = (await import("@/app/api/audit/route")).GET;
});
beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

const passwordHash = hashPassword("correct horse battery");
const get = (path: string, cookie?: string) =>
  new Request(`http://localhost${path}`, { headers: { "x-real-ip": "10.0.0.3", ...(cookie ? { cookie } : {}) } });

async function person(email: string, opts: { workspaceId?: string; role?: "owner" | "admin" | "editor" | "moderator" | "viewer" } = {}) {
  const [user] = await db.insert(users).values({ email, passwordHash: await passwordHash, emailVerifiedAt: new Date() }).returning();
  let workspaceId = opts.workspaceId;
  if (workspaceId) await db.insert(memberships).values({ workspaceId, userId: user.id, role: opts.role ?? "editor" });
  else workspaceId = (await createPersonalWorkspace(db, user)).id;
  return { user, workspaceId, cookie: `session=${createSessionToken(user.id)}` };
}

const at = (iso: string) => new Date(iso);
async function entry(workspaceId: string, over: Partial<typeof auditLog.$inferInsert> = {}) {
  await db.insert(auditLog).values({ workspaceId, actorLabel: "ana@example.com", action: "auth.login", ...over });
}

describe("listAuditEntries", () => {
  it("lists one workspace newest first and pages by 50", async () => {
    const [{ id: a }, { id: b }] = await db.insert(workspaces).values([{ name: "A" }, { name: "B" }]).returning({ id: workspaces.id });
    for (let i = 0; i < 55; i++) await entry(a, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)), targetId: String(i) });
    await entry(b);
    const first = await listAuditEntries(db, a);
    expect(first).toMatchObject({ total: 55, page: 1, pageSize: AUDIT_PAGE_SIZE });
    expect(first.entries).toHaveLength(50);
    expect(first.entries[0].targetId).toBe("54");
    const second = await listAuditEntries(db, a, { page: 2 });
    expect(second.entries.map((e) => e.targetId)).toEqual(["4", "3", "2", "1", "0"]);
  });

  it("filters by action, actor (any case, literally) and date range", async () => {
    const [{ id }] = await db.insert(workspaces).values({ name: "A" }).returning({ id: workspaces.id });
    await entry(id, { action: "auth.login", actorLabel: "Ana@Example.com", createdAt: at("2026-03-01T10:00:00Z") });
    await entry(id, { action: "member.removed", actorLabel: "bob@example.com", createdAt: at("2026-03-02T10:00:00Z") });
    await entry(id, { action: "member.removed", actorLabel: "bo_b@example.com", createdAt: at("2026-03-03T10:00:00Z") });
    expect((await listAuditEntries(db, id, { action: "member.removed" })).total).toBe(2);
    expect((await listAuditEntries(db, id, { actor: "ANA@" })).total).toBe(1);
    expect((await listAuditEntries(db, id, { actor: "bo_b" })).total).toBe(1);
    expect((await listAuditEntries(db, id, { actor: "%" })).total).toBe(0);
    const range = await listAuditEntries(db, id, { from: at("2026-03-02T00:00:00Z"), to: at("2026-03-03T10:00:00Z") });
    expect(range.entries.map((e) => e.actorLabel)).toEqual(["bob@example.com"]);
  });

  it("lists the distinct actions of the workspace", async () => {
    const [{ id }, { id: other }] = await db.insert(workspaces).values([{ name: "A" }, { name: "B" }]).returning({ id: workspaces.id });
    await entry(id, { action: "member.removed" });
    await entry(id, { action: "auth.login" });
    await entry(id, { action: "auth.login" });
    await entry(other, { action: "event.deleted" });
    expect(await listAuditActions(db, id)).toEqual(["auth.login", "member.removed"]);
  });
});

describe("parseAuditFilters", () => {
  it("reads filters and names the parameter that is not usable", () => {
    const ok = parseAuditFilters(new URLSearchParams("action=auth.login&actor= ana &from=2026-01-01T00:00:00Z&page=3"));
    expect(ok).toMatchObject({ ok: true, value: { action: "auth.login", actor: "ana", page: 3 } });
    expect(parseAuditFilters(new URLSearchParams("from=nope"))).toEqual({ ok: false, error: "from" });
    expect(parseAuditFilters(new URLSearchParams("to=nope"))).toEqual({ ok: false, error: "to" });
    expect(parseAuditFilters(new URLSearchParams("page=0"))).toEqual({ ok: false, error: "page" });
    expect(parseAuditFilters(new URLSearchParams("page=1.5"))).toEqual({ ok: false, error: "page" });
  });
});

describe("GET /api/audit", () => {
  it("answers 401 without a session", async () => {
    expect((await list(get("/api/audit"))).status).toBe(401);
  });

  it("is open to owners and admins on Team and closed to every other role", async () => {
    const owner = await person("owner@example.com");
    await setPlan(db, owner.workspaceId, "team");
    await entry(owner.workspaceId);
    const admin = await person("admin@example.com", { workspaceId: owner.workspaceId, role: "admin" });
    for (const who of [owner, admin]) {
      const res = await list(get("/api/audit", who.cookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.entries[0]).toMatchObject({ action: "auth.login", actorLabel: "ana@example.com" });
      expect(typeof body.entries[0].createdAt).toBe("string");
    }
    for (const role of ["editor", "moderator", "viewer"] as const) {
      const who = await person(`${role}@example.com`, { workspaceId: owner.workspaceId, role });
      expect((await list(get("/api/audit", who.cookie))).status).toBe(403);
    }
  });

  it("answers 402 naming Team on Free and Pro", async () => {
    const owner = await person("owner@example.com");
    for (const plan of ["free", "pro"] as const) {
      await setPlan(db, owner.workspaceId, plan);
      const res = await list(get("/api/audit", owner.cookie));
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ reason: "audit_log", requiredPlan: "team" });
    }
  });

  it("applies filters and rejects a bad one with 400", async () => {
    const owner = await person("owner@example.com");
    await setPlan(db, owner.workspaceId, "team");
    await entry(owner.workspaceId, { action: "event.deleted", createdAt: at("2026-05-01T00:00:00Z") });
    await entry(owner.workspaceId, { action: "auth.login", createdAt: at("2026-05-02T00:00:00Z") });
    const body = await (await list(get("/api/audit?action=event.deleted&to=2026-05-03T00:00:00Z", owner.cookie))).json();
    expect(body.entries.map((e: { action: string }) => e.action)).toEqual(["event.deleted"]);
    const bad = await list(get("/api/audit?from=nope", owner.cookie));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "from" });
  });

  it("never shows another workspace's entries", async () => {
    const a = await person("a@example.com");
    const b = await person("b@example.com");
    await setPlan(db, a.workspaceId, "team");
    await entry(b.workspaceId, { action: "event.deleted" });
    expect((await (await list(get("/api/audit", a.cookie))).json()).total).toBe(0);
  });
});
