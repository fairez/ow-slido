// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memberships, userTotp, users, workspaces } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken } from "@/lib/auth/session";
import { totp as totpAt } from "@/lib/auth/totp";
import { twoFactorSetupRequired } from "@/lib/auth/two-factor-policy";
import { getSessionMember } from "@/lib/auth/require-admin";
import { listMembers } from "@/lib/members";
import { getRateLimitStore } from "@/lib/rate-limit";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request) => Promise<Response>;
let setPolicy: Handler;
let templates: Handler;
let membersList: Handler;
let me: Handler;
let status: Handler;
let enrol: Handler;
let confirm: Handler;
let logout: Handler;
let switchWorkspace: Handler;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  setPolicy = (await import("@/app/api/workspaces/active/security/route")).PATCH;
  templates = (await import("@/app/api/templates/route")).GET;
  membersList = (await import("@/app/api/members/route")).GET;
  me = (await import("@/app/api/auth/me/route")).GET;
  status = (await import("@/app/api/auth/2fa/route")).GET;
  enrol = (await import("@/app/api/auth/2fa/enrol/route")).POST;
  confirm = (await import("@/app/api/auth/2fa/confirm/route")).POST;
  logout = (await import("@/app/api/auth/logout/route")).POST;
  switchWorkspace = (await import("@/app/api/workspaces/active/route")).POST;
});

beforeEach(async () => {
  vi.stubEnv("TWOFA_ENCRYPTION_KEY", "c".repeat(64));
  await truncateAll(db);
  await getRateLimitStore().reset();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => pool.end());

const passwordHash = hashPassword("correct horse battery");
const request = (method: string, path: string, cookie?: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-real-ip": "10.0.0.2", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function person(email: string, opts: { workspaceId?: string; role?: "owner" | "admin" | "editor"; twoFactor?: boolean } = {}) {
  const [user] = await db.insert(users).values({ email, passwordHash: await passwordHash, emailVerifiedAt: new Date() }).returning();
  let workspaceId = opts.workspaceId;
  if (workspaceId) await db.insert(memberships).values({ workspaceId, userId: user.id, role: opts.role ?? "editor" });
  else workspaceId = (await createPersonalWorkspace(db, user)).id;
  if (opts.twoFactor) await db.insert(userTotp).values({ userId: user.id, secretEncrypted: "x", confirmedAt: new Date() });
  return { user, workspaceId, cookie: `session=${createSessionToken(user.id)}` };
}

/** A Team workspace that requires 2FA, with an owner who has it on and an editor who does not. */
async function requiringWorkspace() {
  const owner = await person("owner@example.com", { twoFactor: true });
  await setPlan(db, owner.workspaceId, "team");
  await db.update(workspaces).set({ require2fa: true }).where(eq(workspaces.id, owner.workspaceId));
  const editor = await person("editor@example.com", { workspaceId: owner.workspaceId });
  return { owner, editor, workspaceId: owner.workspaceId };
}

describe("PATCH /api/workspaces/active/security", () => {
  it("needs a session and members.manage", async () => {
    const owner = await person("owner@example.com");
    await setPlan(db, owner.workspaceId, "team");
    const editor = await person("editor@example.com", { workspaceId: owner.workspaceId });
    expect((await setPolicy(request("PATCH", "/x", undefined, { require2fa: true }))).status).toBe(401);
    expect((await setPolicy(request("PATCH", "/x", editor.cookie, { require2fa: true }))).status).toBe(403);
  });

  it("answers 402 with the tier on Free and Pro, and stores nothing", async () => {
    const owner = await person("owner@example.com");
    for (const plan of ["free", "pro"] as const) {
      await setPlan(db, owner.workspaceId, plan);
      const res = await setPolicy(request("PATCH", "/x", owner.cookie, { require2fa: true }));
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ reason: "enforced_2fa", requiredPlan: "team" });
    }
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, owner.workspaceId));
    expect(row.require2fa).toBe(false);
  });

  it("turns the requirement on and off for a Team workspace", async () => {
    const owner = await person("owner@example.com", { twoFactor: true });
    await setPlan(db, owner.workspaceId, "team");
    expect(await (await setPolicy(request("PATCH", "/x", owner.cookie, { require2fa: true }))).json()).toEqual({ require2fa: true });
    const read = async () => (await db.select().from(workspaces).where(eq(workspaces.id, owner.workspaceId)))[0].require2fa;
    expect(await read()).toBe(true);
    expect((await setPolicy(request("PATCH", "/x", owner.cookie, { require2fa: false }))).status).toBe(200);
    expect(await read()).toBe(false);
  });

  it("refuses to turn it on while the server has no 2FA key, but still turns it off", async () => {
    const owner = await person("owner@example.com", { twoFactor: true });
    await setPlan(db, owner.workspaceId, "team");
    vi.stubEnv("TWOFA_ENCRYPTION_KEY", "");
    expect((await setPolicy(request("PATCH", "/x", owner.cookie, { require2fa: true }))).status).toBe(503);
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, owner.workspaceId));
    expect(row.require2fa).toBe(false);
    expect((await setPolicy(request("PATCH", "/x", owner.cookie, { require2fa: false }))).status).toBe(200);
  });

  it("lets a workspace that fell below Team switch it off", async () => {
    const owner = await person("owner@example.com");
    await db.update(workspaces).set({ require2fa: true }).where(eq(workspaces.id, owner.workspaceId));
    expect((await setPolicy(request("PATCH", "/x", owner.cookie, { require2fa: false }))).status).toBe(200);
  });

  it("rejects a body without a boolean", async () => {
    const owner = await person("owner@example.com");
    await setPlan(db, owner.workspaceId, "team");
    expect((await setPolicy(request("PATCH", "/x", owner.cookie, { require2fa: "yes" }))).status).toBe(400);
    expect((await setPolicy(request("PATCH", "/x", owner.cookie, {}))).status).toBe(400);
  });
});

describe("enforcement", () => {
  it("holds a member without 2FA out of the workspace APIs with 403 two_factor_required", async () => {
    const { editor } = await requiringWorkspace();
    const res = await templates(request("GET", "/api/templates", editor.cookie));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "two_factor_required" });
  });

  it("lets a member who has 2FA through", async () => {
    const { owner } = await requiringWorkspace();
    expect((await templates(request("GET", "/api/templates", owner.cookie))).status).toBe(200);
  });

  it("treats the held member as no member where anonymous callers are allowed", async () => {
    const { editor, owner, workspaceId } = await requiringWorkspace();
    expect(await getSessionMember(request("GET", "/x", editor.cookie))).toBeNull();
    expect((await getSessionMember(request("GET", "/x", owner.cookie)))?.workspaceId).toBe(workspaceId);
  });

  it("keeps the account, enrolment, logout and workspace switch endpoints open", async () => {
    const { editor } = await requiringWorkspace();
    expect((await me(request("GET", "/api/auth/me", editor.cookie))).status).toBe(200);
    expect((await status(request("GET", "/api/auth/2fa", editor.cookie))).status).toBe(200);
    expect((await enrol(request("POST", "/api/auth/2fa/enrol", editor.cookie, {}))).status).toBe(200);
    expect((await logout(request("POST", "/api/auth/logout", editor.cookie))).status).toBe(200);
    expect((await switchWorkspace(request("POST", "/x", editor.cookie, { workspaceId: editor.workspaceId }))).status).toBe(200);
  });

  it("ends as soon as the member finishes enrolment", async () => {
    const { editor } = await requiringWorkspace();
    expect((await templates(request("GET", "/api/templates", editor.cookie))).status).toBe(403);
    const { secret } = await (await enrol(request("POST", "/api/auth/2fa/enrol", editor.cookie, {}))).json();
    const confirmed = await confirm(request("POST", "/api/auth/2fa/confirm", editor.cookie, { code: totpAt(secret, Date.now()) }));
    expect(confirmed.status).toBe(200);
    expect((await templates(request("GET", "/api/templates", editor.cookie))).status).toBe(200);
  });

  it("does not block a workspace that does not require it, or a member's other workspace", async () => {
    const { editor, workspaceId } = await requiringWorkspace();
    const other = await person("other@example.com");
    await db.insert(memberships).values({ workspaceId: other.workspaceId, userId: editor.user.id, role: "editor" });
    const cookie = `${editor.cookie}; workspace=${other.workspaceId}`;
    expect((await templates(request("GET", "/api/templates", cookie))).status).toBe(200);
    expect(await twoFactorSetupRequired(workspaceId, editor.user.id, db)).toBe(true);
    expect(await twoFactorSetupRequired(other.workspaceId, editor.user.id, db)).toBe(false);
  });

  it("stops enforcing when the plan falls below Team", async () => {
    const { editor, workspaceId } = await requiringWorkspace();
    await setPlan(db, workspaceId, "pro");
    expect(await twoFactorSetupRequired(workspaceId, editor.user.id, db)).toBe(false);
    expect((await templates(request("GET", "/api/templates", editor.cookie))).status).toBe(200);
  });

  it("holds the owner too, and the owner can still enrol", async () => {
    const owner = await person("owner@example.com");
    await setPlan(db, owner.workspaceId, "team");
    await db.update(workspaces).set({ require2fa: true }).where(eq(workspaces.id, owner.workspaceId));
    expect((await membersList(request("GET", "/api/members", owner.cookie))).status).toBe(403);
    expect((await enrol(request("POST", "/api/auth/2fa/enrol", owner.cookie, {}))).status).toBe(200);
  });
});

describe("member list", () => {
  it("reports who has 2FA on, and ignores an unfinished enrolment", async () => {
    const { workspaceId } = await requiringWorkspace();
    const pending = await person("pending@example.com", { workspaceId });
    await db.insert(userTotp).values({ userId: pending.user.id, secretEncrypted: "x" });
    const rows = await listMembers(db, workspaceId);
    expect(Object.fromEntries(rows.map((m) => [m.email, m.twoFactor]))).toEqual({
      "owner@example.com": true,
      "editor@example.com": false,
      "pending@example.com": false,
    });
  });
});
