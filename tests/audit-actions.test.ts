// @vitest-environment node
import { createHmac } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, interactions, memberships, noteAnalyses, participants, sharedNotes, users } from "@/db/schema";
import { AUDIT_DENY_KEYS } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { issueToken } from "@/lib/auth/tokens";
import { totp as totpAt } from "@/lib/auth/totp";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

const PASSWORD = "correct horse battery";
const NOTE_TEXT = "private note body that must never be logged";
const IP = "203.0.113.7";
const WEBHOOK_SECRET = "whsec-audit";

type Handler = (req: Request) => Promise<Response>;
type Ctx<P> = { params: Promise<P> };
type IdHandler = (req: Request, ctx: Ctx<{ id: string }>) => Promise<Response>;
type UserHandler = (req: Request, ctx: Ctx<{ userId: string }>) => Promise<Response>;

let login: Handler;
let verify: Handler;
let changePassword: Handler;
let resetPassword: Handler;
let enrol: Handler;
let confirm: Handler;
let disable: Handler;
let memberPatch: UserHandler;
let memberDelete: UserHandler;
let memberPassword: UserHandler;
let createInvite: Handler;
let revokeInvite: IdHandler;
let acceptInvite: Handler;
let webhook: Handler;
let cancel: Handler;
let eventDelete: IdHandler;
let templatesPost: Handler;
let templateDelete: IdHandler;
let csvExport: IdHandler;
let zipExport: IdHandler;
let analyze: IdHandler;
let security: (req: Request) => Promise<Response>;
let eventsPost: Handler;
let collection: IdHandler;
let session: typeof import("@/lib/auth/session");
let lib: typeof import("@/lib/note-analysis");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  login = (await import("@/app/api/auth/login/route")).POST;
  verify = (await import("@/app/api/auth/2fa/verify/route")).POST;
  changePassword = (await import("@/app/api/auth/password/route")).POST;
  resetPassword = (await import("@/app/api/auth/reset/route")).POST;
  enrol = (await import("@/app/api/auth/2fa/enrol/route")).POST;
  confirm = (await import("@/app/api/auth/2fa/confirm/route")).POST;
  disable = (await import("@/app/api/auth/2fa/disable/route")).POST;
  memberPatch = (await import("@/app/api/members/[userId]/route")).PATCH;
  memberDelete = (await import("@/app/api/members/[userId]/route")).DELETE;
  memberPassword = (await import("@/app/api/members/[userId]/password/route")).POST;
  createInvite = (await import("@/app/api/invitations/route")).POST;
  revokeInvite = (await import("@/app/api/invitations/[id]/route")).DELETE;
  acceptInvite = (await import("@/app/api/invitations/accept/route")).POST;
  webhook = (await import("@/app/api/billing/webhook/route")).POST;
  cancel = (await import("@/app/api/billing/cancel/route")).POST;
  eventDelete = (await import("@/app/api/events/[id]/route")).DELETE;
  templatesPost = (await import("@/app/api/templates/route")).POST;
  templateDelete = (await import("@/app/api/templates/[id]/route")).DELETE;
  csvExport = (await import("@/app/api/events/[id]/export.csv/route")).GET;
  zipExport = (await import("@/app/api/events/[id]/export.zip/route")).GET;
  analyze = (await import("@/app/api/interactions/[id]/analyze/route")).POST;
  security = (await import("@/app/api/workspaces/active/security/route")).PATCH;
  eventsPost = (await import("@/app/api/events/route")).POST;
  collection = (await import("@/app/api/events/[id]/interactions/route")).POST;
  session = await import("@/lib/auth/session");
  lib = await import("@/lib/note-analysis");
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

beforeEach(async () => {
  vi.stubEnv("TWOFA_ENCRYPTION_KEY", "c".repeat(64));
  vi.stubEnv("BILLING_PROVIDER", "mock");
  vi.stubEnv("BILLING_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("EMAIL_PROVIDER", "log");
  lib.setAnalysisRunner(async () => ({
    summary: "S",
    categories: [{ name: "A", noteIds: [] }],
    keywords: [{ word: "w", weight: 1 }],
    model: "m",
    promptVersion: "v1",
  }));
  await truncateAll(db);
  await getRateLimitStore().reset();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  lib.setAnalysisRunner(null);
  await pool.end();
});

const req = (method: string, path: string, body?: unknown, cookie?: string) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-real-ip": IP, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = <P extends Record<string, string>>(params: P): Ctx<P> => ({ params: Promise.resolve(params) });

async function makeUser(email: string, plan: "free" | "pro" | "team" = "team") {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() })
    .returning();
  const workspace = await createPersonalWorkspace(db, user);
  await setPlan(db, workspace.id, plan);
  return { user, workspaceId: workspace.id, cookie: `session=${session.createSessionToken(user.id)}` };
}

async function addMember(workspaceId: string, email: string, role: "admin" | "editor" | "viewer") {
  const member = await makeUser(email, "free");
  await db.insert(memberships).values({ workspaceId, userId: member.user.id, role });
  return member;
}

const entries = async (action?: string) => {
  const rows = await db.select().from(auditLog).orderBy(asc(auditLog.createdAt));
  return action ? rows.filter((row) => row.action === action) : rows;
};
const one = async (action: string) => {
  const rows = await entries(action);
  expect(rows, action).toHaveLength(1);
  return rows[0];
};

describe("login", () => {
  it("records a success and a failure of a known account, never an unknown email", async () => {
    const owner = await makeUser("owner@example.com");
    const wrong = await login(req("POST", "/api/auth/login", { email: "owner@example.com", password: "not the password" }));
    expect(wrong.status).toBe(401);
    const unknown = await login(req("POST", "/api/auth/login", { email: "nobody@example.com", password: "whatever password" }));
    expect(unknown.status).toBe(401);
    const ok = await login(req("POST", "/api/auth/login", { email: "owner@example.com", password: PASSWORD }));
    expect(ok.status).toBe(200);

    const failed = await one("auth.login_failed");
    expect(failed).toMatchObject({
      workspaceId: owner.workspaceId,
      actorUserId: owner.user.id,
      actorLabel: "owner@example.com",
      ip: IP,
      targetType: "user",
      targetId: owner.user.id,
    });
    expect(failed.metadata).toEqual({ step: "password" });
    const success = await one("auth.login");
    expect(success).toMatchObject({ workspaceId: owner.workspaceId, actorLabel: "owner@example.com", ip: IP });
    expect(await entries()).toHaveLength(2);
  });

  it("records the second factor step of a login", async () => {
    const owner = await makeUser("owner@example.com");
    const { secret } = await (await enrol(req("POST", "/api/auth/2fa/enrol", {}, owner.cookie))).json();
    await confirm(req("POST", "/api/auth/2fa/confirm", { code: totpAt(secret, Date.now()) }, owner.cookie));
    const { pendingToken } = await (await login(req("POST", "/api/auth/login", { email: "owner@example.com", password: PASSWORD }))).json();
    expect(await entries("auth.login")).toHaveLength(0);

    await verify(req("POST", "/api/auth/2fa/verify", { pendingToken, code: "000000" }));
    expect((await one("auth.login_failed")).metadata).toMatchObject({ step: "second_factor", reason: "invalid" });
    const res = await verify(req("POST", "/api/auth/2fa/verify", { pendingToken, code: totpAt(secret, Date.now()) }));
    expect(res.status).toBe(200);
    expect((await one("auth.login")).metadata).toMatchObject({ secondFactor: true, method: "totp" });
  });
});

describe("password and 2FA", () => {
  it("records a password change and a reset through the emailed link", async () => {
    const owner = await makeUser("owner@example.com");
    const res = await changePassword(
      req("POST", "/api/auth/password", { currentPassword: PASSWORD, newPassword: "a brand new passphrase" }, owner.cookie),
    );
    expect(res.status).toBe(200);
    const changed = await one("auth.password_changed");
    expect(changed).toMatchObject({ workspaceId: owner.workspaceId, actorLabel: "owner@example.com", ip: IP });

    const issued = await issueToken(db, { userId: owner.user.id, purpose: "reset_password", ttlMs: 60_000 });
    const reset = await resetPassword(req("POST", "/api/auth/reset", { token: issued, password: "yet another passphrase" }));
    expect(reset.status).toBe(200);
    expect(await one("auth.password_reset")).toMatchObject({ workspaceId: owner.workspaceId, actorLabel: "owner@example.com" });
  });

  it("records enabling and disabling 2FA", async () => {
    const owner = await makeUser("owner@example.com");
    const { secret } = await (await enrol(req("POST", "/api/auth/2fa/enrol", {}, owner.cookie))).json();
    expect((await confirm(req("POST", "/api/auth/2fa/confirm", { code: totpAt(secret, Date.now()) }, owner.cookie))).status).toBe(200);
    expect(await one("auth.2fa_enabled")).toMatchObject({ workspaceId: owner.workspaceId, actorUserId: owner.user.id, ip: IP });

    const off = await disable(req("POST", "/api/auth/2fa/disable", { password: PASSWORD, code: totpAt(secret, Date.now() + 30_000) }, owner.cookie));
    expect(off.status).toBe(200);
    expect(await one("auth.2fa_disabled")).toMatchObject({ workspaceId: owner.workspaceId, actorUserId: owner.user.id });
  });

  it("writes nothing for a failed disable", async () => {
    const owner = await makeUser("owner@example.com");
    const { secret } = await (await enrol(req("POST", "/api/auth/2fa/enrol", {}, owner.cookie))).json();
    await confirm(req("POST", "/api/auth/2fa/confirm", { code: totpAt(secret, Date.now()) }, owner.cookie));
    const bad = await disable(req("POST", "/api/auth/2fa/disable", { password: "wrong wrong wrong", code: "000000" }, owner.cookie));
    expect(bad.status).toBe(400);
    expect(await entries("auth.2fa_disabled")).toHaveLength(0);
  });
});

describe("members and invitations", () => {
  it("records role change, suspend, reactivate, password reset and remove", async () => {
    const owner = await makeUser("owner@example.com");
    const member = await addMember(owner.workspaceId, "member@example.com", "editor");
    const target = ctx({ userId: member.user.id });

    expect((await memberPatch(req("PATCH", "/x", { role: "admin" }, owner.cookie), target)).status).toBe(200);
    expect(await one("member.role_changed")).toMatchObject({
      workspaceId: owner.workspaceId,
      actorUserId: owner.user.id,
      actorLabel: "owner@example.com",
      targetType: "user",
      targetId: member.user.id,
      ip: IP,
      metadata: { fromRole: "editor", toRole: "admin" },
    });

    expect((await memberPatch(req("PATCH", "/x", { status: "suspended" }, owner.cookie), target)).status).toBe(200);
    expect((await memberPatch(req("PATCH", "/x", { status: "active" }, owner.cookie), target)).status).toBe(200);
    await one("member.suspended");
    await one("member.reactivated");

    expect((await memberPassword(req("POST", "/x", undefined, owner.cookie), target)).status).toBe(200);
    await one("member.password_reset");

    expect((await memberDelete(req("DELETE", "/x", undefined, owner.cookie), target)).status).toBe(200);
    expect(await one("member.removed")).toMatchObject({ targetId: member.user.id, metadata: { role: "admin" } });
  });

  it("writes nothing when the change is refused", async () => {
    const owner = await makeUser("owner@example.com");
    const res = await memberPatch(req("PATCH", "/x", { role: "admin" }, owner.cookie), ctx({ userId: owner.user.id }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await entries()).toHaveLength(0);
  });

  it("records an invitation created, revoked and accepted", async () => {
    const owner = await makeUser("owner@example.com");
    const first = await createInvite(req("POST", "/api/invitations", { email: "revoked@example.com", role: "editor" }, owner.cookie));
    const { invitation } = await first.json();
    expect(await one("invitation.created")).toMatchObject({
      workspaceId: owner.workspaceId,
      actorLabel: "owner@example.com",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { role: "editor" },
    });
    expect((await revokeInvite(req("DELETE", "/x", undefined, owner.cookie), ctx({ id: invitation.id }))).status).toBe(200);
    expect(await one("invitation.revoked")).toMatchObject({ targetId: invitation.id });

    const second = await (await createInvite(req("POST", "/api/invitations", { email: "joiner@example.com", role: "viewer" }, owner.cookie))).json();
    const token = new URL(second.link).searchParams.get("token");
    const accepted = await acceptInvite(req("POST", "/api/invitations/accept", { token, password: PASSWORD }));
    expect(accepted.status).toBe(200);
    const [joiner] = await db.select().from(users).where(eq(users.email, "joiner@example.com"));
    expect(await one("member.added")).toMatchObject({
      workspaceId: owner.workspaceId,
      actorUserId: joiner.id,
      actorLabel: "joiner@example.com",
      targetId: joiner.id,
      metadata: { role: "viewer", via: "invitation" },
    });
  });
});

describe("billing", () => {
  const sign = (raw: string) => createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  const send = (body: object) => {
    const raw = JSON.stringify(body);
    return webhook(
      new Request("http://localhost/api/billing/webhook", { method: "POST", headers: { "x-mock-signature": sign(raw) }, body: raw }),
    );
  };
  const billingEvent = (workspaceId: string, overrides: Record<string, unknown>) => ({
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

  it("records a plan change and a cancel from billing events, once per change", async () => {
    const owner = await makeUser("owner@example.com", "free");
    expect((await send(billingEvent(owner.workspaceId, {}))).status).toBe(200);
    expect(await one("billing.plan_changed")).toMatchObject({
      workspaceId: owner.workspaceId,
      actorLabel: "billing:mock",
      targetType: "subscription",
      metadata: { fromPlan: "free", toPlan: "pro", status: "active" },
    });

    // A renewal on the same plan is not a plan change.
    await send(billingEvent(owner.workspaceId, { id: "evt_2" }));
    expect(await entries("billing.plan_changed")).toHaveLength(1);

    await send(billingEvent(owner.workspaceId, { id: "evt_3", status: "canceled" }));
    expect(await one("billing.canceled")).toMatchObject({ workspaceId: owner.workspaceId, metadata: { plan: "pro" } });
    await send(billingEvent(owner.workspaceId, { id: "evt_4", status: "canceled" }));
    expect(await entries("billing.canceled")).toHaveLength(1);
  });

  it("records who asked to cancel", async () => {
    const owner = await makeUser("owner@example.com", "free");
    await send(billingEvent(owner.workspaceId, {}));
    expect((await cancel(req("POST", "/api/billing/cancel", {}, owner.cookie))).status).toBe(200);
    expect(await one("billing.cancel_requested")).toMatchObject({
      workspaceId: owner.workspaceId,
      actorUserId: owner.user.id,
      actorLabel: "owner@example.com",
      ip: IP,
    });
  });
});

describe("content and workspace", () => {
  const makeEvent = async (cookie: string) => {
    const res = await eventsPost(
      req("POST", "/api/events", { name: "Town hall", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }, cookie),
    );
    return (await res.json()).event as { id: string };
  };

  it("records an event delete", async () => {
    const owner = await makeUser("owner@example.com");
    const event = await makeEvent(owner.cookie);
    expect((await eventDelete(req("DELETE", "/x", undefined, owner.cookie), ctx({ id: event.id }))).status).toBe(204);
    expect(await one("event.deleted")).toMatchObject({
      workspaceId: owner.workspaceId,
      actorLabel: "owner@example.com",
      targetType: "event",
      targetId: event.id,
      metadata: { eventName: "Town hall" },
      ip: IP,
    });
  });

  it("records a template delete", async () => {
    const owner = await makeUser("owner@example.com");
    const event = await makeEvent(owner.cookie);
    const saved = await templatesPost(req("POST", "/api/templates", { eventId: event.id, name: "Kickoff" }, owner.cookie));
    const { template } = await saved.json();
    expect((await templateDelete(req("DELETE", "/x", undefined, owner.cookie), ctx({ id: template.id }))).status).toBe(200);
    expect(await one("template.deleted")).toMatchObject({
      workspaceId: owner.workspaceId,
      targetType: "template",
      targetId: template.id,
      metadata: { templateName: "Kickoff" },
    });
  });

  it("records CSV and ZIP exports", async () => {
    const owner = await makeUser("owner@example.com");
    const event = await makeEvent(owner.cookie);
    expect((await csvExport(req("GET", "/x", undefined, owner.cookie), ctx({ id: event.id }))).status).toBe(200);
    expect((await zipExport(req("GET", "/x", undefined, owner.cookie), ctx({ id: event.id }))).status).toBe(200);
    const rows = await entries("event.exported");
    expect(rows.map((row) => (row.metadata as { format: string }).format).sort()).toEqual(["csv", "zip"]);
    expect(rows[0]).toMatchObject({ workspaceId: owner.workspaceId, targetId: event.id, actorUserId: owner.user.id, ip: IP });
  });

  it("records the AI notice acceptance once and each analysis run", async () => {
    const owner = await makeUser("owner@example.com", "pro");
    const event = await makeEvent(owner.cookie);
    const created = await collection(req("POST", "/x", { type: "sharedNotes", prompt: "Thoughts?" }, owner.cookie), ctx({ id: event.id }));
    const notesId = (await created.json()).interaction.id as string;
    await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, notesId));
    const [participant] = await db.insert(participants).values({ eventId: event.id }).returning();
    await db.insert(sharedNotes).values({ interactionId: notesId, participantId: participant.id, text: NOTE_TEXT, status: "approved" });

    const refused = await analyze(req("POST", "/x", {}, owner.cookie), ctx({ id: notesId }));
    expect(refused.status).toBe(409);
    expect(await entries()).toHaveLength(0);

    expect((await analyze(req("POST", "/x", { acceptNotice: true }, owner.cookie), ctx({ id: notesId }))).status).toBe(202);
    await vi.waitFor(async () => {
      const rows = await db.select({ status: noteAnalyses.status }).from(noteAnalyses);
      expect(rows.map((row) => row.status)).toEqual(["done"]);
    });
    expect((await analyze(req("POST", "/x", {}, owner.cookie), ctx({ id: notesId }))).status).toBe(202);

    expect(await one("ai.notice_accepted")).toMatchObject({ workspaceId: owner.workspaceId, targetType: "event", targetId: event.id });
    const runs = await entries("ai.analysis_started");
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ workspaceId: owner.workspaceId, targetType: "interaction", targetId: notesId, actorLabel: "owner@example.com" });
  });

  it("records a workspace settings change only when the value changes", async () => {
    const owner = await makeUser("owner@example.com", "team");
    expect((await security(req("PATCH", "/x", { require2fa: false }, owner.cookie))).status).toBe(200);
    expect(await entries("workspace.settings_changed")).toHaveLength(0);

    expect((await security(req("PATCH", "/x", { require2fa: true }, owner.cookie))).status).toBe(200);
    expect(await one("workspace.settings_changed")).toMatchObject({
      workspaceId: owner.workspaceId,
      actorLabel: "owner@example.com",
      targetType: "workspace",
      targetId: owner.workspaceId,
      metadata: { setting: "require_2fa", from: false, to: true },
    });
  });
});

describe("what an entry may hold", () => {
  it("has actor, action, time and IP on every entry and no secrets or note text anywhere", async () => {
    const owner = await makeUser("owner@example.com");
    const member = await addMember(owner.workspaceId, "member@example.com", "editor");

    // Sensitive input goes through every route that takes some.
    await login(req("POST", "/api/auth/login", { email: "owner@example.com", password: "wrong wrong wrong" }));
    await login(req("POST", "/api/auth/login", { email: "owner@example.com", password: PASSWORD }));
    await memberPassword(req("POST", "/x", undefined, owner.cookie), ctx({ userId: member.user.id }));
    await memberPatch(req("PATCH", "/x", { role: "admin" }, owner.cookie), ctx({ userId: member.user.id }));
    await memberDelete(req("DELETE", "/x", undefined, owner.cookie), ctx({ userId: member.user.id }));
    const { secret } = await (await enrol(req("POST", "/api/auth/2fa/enrol", {}, owner.cookie))).json();
    await confirm(req("POST", "/api/auth/2fa/confirm", { code: totpAt(secret, Date.now()) }, owner.cookie));
    await security(req("PATCH", "/x", { require2fa: true }, owner.cookie));
    await createInvite(req("POST", "/api/invitations", { email: "joiner@example.com", role: "viewer" }, owner.cookie));
    // Last, because it ends the session the calls above used.
    await changePassword(req("POST", "/api/auth/password", { currentPassword: PASSWORD, newPassword: "n3w passphrase here" }, owner.cookie));

    const rows = await entries();
    expect(rows.length).toBeGreaterThanOrEqual(8);

    const everything = JSON.stringify(rows);
    for (const secretValue of [PASSWORD, "wrong wrong wrong", "n3w passphrase here", NOTE_TEXT, secret, "temporaryPassword"]) {
      expect(everything).not.toContain(secretValue);
    }
    for (const row of rows) {
      expect(row.actorLabel, row.action).toBeTruthy();
      expect(row.action).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+$/);
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.ip, row.action).toBe(IP);
      expect(row.workspaceId, row.action).toBe(owner.workspaceId);
      const keys = (function walk(value: unknown): string[] {
        if (Array.isArray(value)) return value.flatMap(walk);
        if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [k, ...walk(v)]);
        return [];
      })(row.metadata);
      for (const key of keys) {
        for (const word of AUDIT_DENY_KEYS) expect(key.toLowerCase(), `${row.action}.${key}`).not.toContain(word);
      }
    }
  });
});
