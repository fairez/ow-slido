// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, events, interactions, memberships, recoveryCodes, subscriptions, userTotp, users, workspaces } from "@/db/schema";
import { listAuditEntries } from "@/lib/audit-query";
import { hashPassword } from "@/lib/auth/password";
import { getSessionMember, getUserFromToken } from "@/lib/auth/require-admin";
import { createSessionToken } from "@/lib/auth/session";
import { getTwoFactorStatus } from "@/lib/auth/two-factor";
import { getEntitlements } from "@/lib/plans";
import { eventUnavailable, workspaceSuspended } from "@/lib/workspace-suspension";
import { getOpsAiStatus } from "@/lib/ops-ai";
import { listOperatorActivity } from "@/lib/ops-audit";
import { getOpsWorkspaceDetail, listOpsWorkspaces } from "@/lib/ops-workspaces";
import { aiCalls } from "@/db/schema";
import { getRateLimitStore } from "@/lib/rate-limit";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
let suspend: Handler;
let reactivate: Handler;
let putOverride: Handler;
let deleteOverride: Handler;
let reset2fa: Handler;
let detail: Handler;
let aiStatus: Handler;
let activity: Handler;
let listEvents: Handler;
let join: Handler;
let live: Handler;
let surveyJoin: Handler;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  suspend = (await import("@/app/api/ops/workspaces/[id]/suspend/route")).POST as Handler;
  reactivate = (await import("@/app/api/ops/workspaces/[id]/reactivate/route")).POST as Handler;
  const override = await import("@/app/api/ops/workspaces/[id]/plan-override/route");
  putOverride = override.PUT as Handler;
  deleteOverride = override.DELETE as Handler;
  reset2fa = (await import("@/app/api/ops/workspaces/[id]/members/[userId]/reset-2fa/route")).POST as Handler;
  detail = (await import("@/app/api/ops/workspaces/[id]/route")).GET as Handler;
  aiStatus = (await import("@/app/api/ops/ai/route")).GET as Handler;
  activity = (await import("@/app/api/ops/activity/route")).GET as Handler;
  listEvents = (await import("@/app/api/events/route")).GET as Handler;
  join = (await import("@/app/api/join/route")).POST as Handler;
  live = (await import("@/app/api/events/[id]/live/route")).GET as Handler;
  surveyJoin = (await import("@/app/api/interactions/[id]/survey/join/route")).POST as Handler;
});

beforeEach(async () => {
  vi.stubEnv("OPERATOR_EMAILS", "boss@example.com");
  await truncateAll(db);
  await getRateLimitStore().reset();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => pool.end());

const passwordHash = hashPassword("correct horse battery");
const call = (method: string, path: string, cookie?: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-real-ip": "10.0.0.9", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function person(email: string, opts: { workspaceId?: string; role?: "owner" | "editor" } = {}) {
  const [user] = await db.insert(users).values({ email, passwordHash: await passwordHash, emailVerifiedAt: new Date() }).returning();
  let workspaceId = opts.workspaceId;
  if (workspaceId) await db.insert(memberships).values({ workspaceId, userId: user.id, role: opts.role ?? "editor" });
  else workspaceId = (await createPersonalWorkspace(db, user)).id;
  return { user, workspaceId, cookie: `session=${createSessionToken(user.id)}` };
}

async function world() {
  const operator = await person("boss@example.com");
  const host = await person("host@example.com");
  const [event] = await db
    .insert(events)
    .values({
      workspaceId: host.workspaceId,
      ownerId: host.user.id,
      name: "Town hall",
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T11:00:00Z"),
      joinCode: "424242",
    })
    .returning();
  return { operator, host, event };
}

const suspendIt = (op: { cookie: string }, workspaceId: string, reason: unknown = "abuse report") =>
  suspend(call("POST", `/api/ops/workspaces/${workspaceId}/suspend`, op.cookie, { reason }), ctx({ id: workspaceId }));

describe("operator routes stay hidden", () => {
  it("answers 404 to a member and to a visitor on every new route", async () => {
    const { host, event } = await world();
    const id = host.workspaceId;
    for (const cookie of [host.cookie, undefined]) {
      const answers = await Promise.all([
        suspend(call("POST", "/x", cookie, { reason: "r" }), ctx({ id })),
        reactivate(call("POST", "/x", cookie), ctx({ id })),
        putOverride(call("PUT", "/x", cookie, {}), ctx({ id })),
        deleteOverride(call("DELETE", "/x", cookie), ctx({ id })),
        reset2fa(call("POST", "/x", cookie), ctx({ id, userId: host.user.id })),
        detail(call("GET", "/x", cookie), ctx({ id })),
        aiStatus(call("GET", "/x", cookie)),
        activity(call("GET", "/x", cookie)),
      ]);
      expect(answers.map((r) => r.status)).toEqual(answers.map(() => 404));
    }
    expect(await workspaceSuspended(host.workspaceId)).toBe(false);
    expect(event.id).toBeTruthy();
  });
});

describe("suspension", () => {
  it("requires a reason and refuses unknown or already suspended workspaces", async () => {
    const { operator, host } = await world();
    expect((await suspendIt(operator, host.workspaceId, "  ")).status).toBe(400);
    expect((await suspendIt(operator, host.workspaceId, "x".repeat(301))).status).toBe(400);
    expect((await suspendIt(operator, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await suspendIt(operator, host.workspaceId)).status).toBe(200);
    expect((await suspendIt(operator, host.workspaceId)).status).toBe(409);
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, host.workspaceId));
    expect(row.suspendedAt).toBeInstanceOf(Date);
    expect(row.suspendedReason).toBe("abuse report");
  });

  it("blocks the host's routes, and lets them back in after reactivation", async () => {
    const { operator, host } = await world();
    expect((await listEvents(call("GET", "/api/events", host.cookie))).status).toBe(200);
    await suspendIt(operator, host.workspaceId);

    const blocked = await listEvents(call("GET", "/api/events", host.cookie));
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ reason: "workspace_suspended" });
    expect(await getSessionMember(call("GET", "/x", host.cookie))).toBeNull();

    const res = await reactivate(call("POST", "/x", operator.cookie), ctx({ id: host.workspaceId }));
    expect(res.status).toBe(200);
    expect((await listEvents(call("GET", "/api/events", host.cookie))).status).toBe(200);
    expect(await getSessionMember(call("GET", "/x", host.cookie))).not.toBeNull();
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, host.workspaceId));
    expect(row.suspendedAt).toBeNull();
    expect(row.suspendedReason).toBeNull();
  });

  it("does not suspend the operator's own other workspaces", async () => {
    const { operator, host } = await world();
    await suspendIt(operator, host.workspaceId);
    expect((await listEvents(call("GET", "/api/events", operator.cookie))).status).toBe(200);
  });

  it("tells participants only that the event is unavailable", async () => {
    const { operator, host, event } = await world();
    const joined = await join(call("POST", "/api/join", undefined, { code: event.joinCode }));
    expect(joined.status).toBe(200);
    const participantCookie = joined.headers.get("set-cookie")!.split(";")[0];

    await suspendIt(operator, host.workspaceId, "chargeback fraud");

    const again = await join(call("POST", "/api/join", undefined, { code: event.joinCode }));
    expect(again.status).toBe(403);
    const body = await again.json();
    expect(body).toMatchObject({ reason: "event_unavailable", error: "This event is not available right now." });
    expect(JSON.stringify(body)).not.toContain("fraud");
    expect(JSON.stringify(body)).not.toContain("suspend");

    const liveRes = await live(call("GET", `/api/events/${event.id}/live`, participantCookie), ctx({ id: event.id }));
    expect(liveRes.status).toBe(403);
    expect(await liveRes.json()).toMatchObject({ reason: "event_unavailable" });

    expect(await eventUnavailable(event.id)).toBe(true);
    await reactivate(call("POST", "/x", operator.cookie), ctx({ id: host.workspaceId }));
    expect(await eventUnavailable(event.id)).toBe(false);
    expect((await live(call("GET", `/api/events/${event.id}/live`, participantCookie), ctx({ id: event.id }))).status).toBe(200);
  });

  it("refuses the survey link too", async () => {
    const { operator, host, event } = await world();
    const [survey] = await db
      .insert(interactions)
      .values({ eventId: event.id, type: "survey", title: "Feedback", state: "live", position: 0, config: { questions: [] } })
      .returning();
    await suspendIt(operator, host.workspaceId);
    const res = await surveyJoin(call("POST", "/x"), ctx({ id: survey.id }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "event_unavailable" });
  });

  it("answers in Indonesian when asked", async () => {
    const { operator, host } = await world();
    await suspendIt(operator, host.workspaceId);
    const res = await listEvents(call("GET", "/api/events", `${host.cookie}; lang=id`));
    expect((await res.json()).error).toBe("Ruang kerja ini ditangguhkan.");
  });
});

describe("plan override", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    plan: "team",
    until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    reason: "goodwill after outage",
    ...over,
  });
  const put = (op: { cookie: string }, id: string, b: unknown) =>
    putOverride(call("PUT", "/x", op.cookie, b), ctx({ id }));

  it("rejects a missing reason, a bad plan and a bad end date", async () => {
    const { operator, host } = await world();
    expect((await put(operator, host.workspaceId, body({ reason: "" }))).status).toBe(400);
    expect((await put(operator, host.workspaceId, body({ plan: "gold" }))).status).toBe(400);
    expect((await put(operator, host.workspaceId, body({ until: "" }))).status).toBe(400);
    expect((await put(operator, host.workspaceId, body({ until: new Date(Date.now() - 1000).toISOString() }))).status).toBe(400);
    expect((await put(operator, host.workspaceId, body({ until: new Date(Date.now() + 400 * 86_400_000).toISOString() }))).status).toBe(400);
    expect((await put(operator, "00000000-0000-4000-8000-000000000000", body())).status).toBe(404);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it("applies the plan, keeps the reason in the override columns and stops at the end date", async () => {
    const { operator, host } = await world();
    expect((await getEntitlements(host.workspaceId)).plan).toBe("free");
    const until = new Date(Date.now() + 10 * 86_400_000);
    const res = await put(operator, host.workspaceId, body({ until: until.toISOString() }));
    expect(res.status).toBe(200);

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, host.workspaceId));
    expect(row).toMatchObject({ planOverride: "team", planOverrideReason: "goodwill after outage" });
    expect(row.planOverrideUntil?.getTime()).toBe(until.getTime());

    expect(await getEntitlements(host.workspaceId)).toMatchObject({ plan: "team", source: "override" });
    const later = new Date(until.getTime() + 1000);
    expect(await getEntitlements(host.workspaceId, { now: later })).toMatchObject({ plan: "free", source: "free" });

    const info = await getOpsWorkspaceDetail(db, host.workspaceId, later);
    expect(info?.override).toMatchObject({ plan: "team", active: false });
    expect((await getOpsWorkspaceDetail(db, host.workspaceId))?.override).toMatchObject({ active: true });
  });

  it("replaces an override on a paid workspace without touching the subscription", async () => {
    const { operator, host } = await world();
    await db.insert(subscriptions).values({ workspaceId: host.workspaceId, plan: "pro", status: "active", provider: "mock", providerSubscriptionId: "sub_1" });
    await put(operator, host.workspaceId, body({ plan: "team" }));
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, host.workspaceId));
    expect(row).toMatchObject({ plan: "pro", status: "active", providerSubscriptionId: "sub_1", planOverride: "team" });

    const res = await deleteOverride(call("DELETE", "/x", operator.cookie), ctx({ id: host.workspaceId }));
    expect(res.status).toBe(200);
    expect(await getEntitlements(host.workspaceId)).toMatchObject({ plan: "pro", source: "subscription" });
    const [cleared] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, host.workspaceId));
    expect(cleared).toMatchObject({ planOverride: null, planOverrideUntil: null, planOverrideReason: null });
    expect((await deleteOverride(call("DELETE", "/x", operator.cookie), ctx({ id: host.workspaceId }))).status).toBe(404);
  });
});

describe("2FA reset", () => {
  async function withTwoFactor(userId: string) {
    await db.insert(userTotp).values({ userId, secretEncrypted: "x", confirmedAt: new Date() });
    await db.insert(recoveryCodes).values([
      { userId, codeHash: "a" },
      { userId, codeHash: "b" },
    ]);
  }

  it("removes the secret and recovery codes and ends the member's sessions", async () => {
    const { operator, host } = await world();
    const member = await person("member@example.com", { workspaceId: host.workspaceId });
    await withTwoFactor(member.user.id);
    await withTwoFactor(host.user.id);
    expect((await getUserFromToken(member.cookie.replace("session=", "")))?.id).toBe(member.user.id);
    await new Promise((r) => setTimeout(r, 5));

    const res = await reset2fa(call("POST", "/x", operator.cookie), ctx({ id: host.workspaceId, userId: member.user.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hadTwoFactor: true });

    expect(await getTwoFactorStatus(db, member.user.id)).toEqual({ enabled: false, pending: false });
    expect(await db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, member.user.id))).toHaveLength(0);
    expect(await getUserFromToken(member.cookie.replace("session=", ""))).toBeNull();
    // Someone else's 2FA is untouched.
    expect((await getTwoFactorStatus(db, host.user.id)).enabled).toBe(true);
    expect(await db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, host.user.id))).toHaveLength(2);
  });

  it("only works for a member of that workspace", async () => {
    const { operator, host } = await world();
    const stranger = await person("stranger@example.com");
    await withTwoFactor(stranger.user.id);
    const res = await reset2fa(call("POST", "/x", operator.cookie), ctx({ id: host.workspaceId, userId: stranger.user.id }));
    expect(res.status).toBe(404);
    expect((await getTwoFactorStatus(db, stranger.user.id)).enabled).toBe(true);
  });
});

describe("audit trail", () => {
  it("records each action with the operator as actor, in the workspace log and the platform view", async () => {
    const { operator, host } = await world();
    const id = host.workspaceId;
    const member = await person("member@example.com", { workspaceId: id });
    await db.insert(userTotp).values({ userId: member.user.id, secretEncrypted: "x", confirmedAt: new Date() });

    await suspendIt(operator, id, "payment dispute");
    await reactivate(call("POST", "/x", operator.cookie), ctx({ id }));
    await putOverride(
      call("PUT", "/x", operator.cookie, { plan: "pro", until: new Date(Date.now() + 86_400_000 * 5).toISOString(), reason: "trial" }),
      ctx({ id }),
    );
    await deleteOverride(call("DELETE", "/x", operator.cookie), ctx({ id }));
    await reset2fa(call("POST", "/x", operator.cookie), ctx({ id, userId: member.user.id }));

    const own = await listAuditEntries(db, id);
    expect(own.entries.map((e) => e.action).sort()).toEqual([
      "operator.plan_override_cleared",
      "operator.plan_override_set",
      "operator.two_factor_reset",
      "operator.workspace_reactivated",
      "operator.workspace_suspended",
    ]);
    for (const entry of own.entries) expect(entry.actorLabel).toBe("operator:boss@example.com");
    const suspended = own.entries.find((e) => e.action === "operator.workspace_suspended");
    expect(suspended).toMatchObject({ targetType: "workspace", targetId: id, metadata: { reason: "payment dispute" } });
    const reset = own.entries.find((e) => e.action === "operator.two_factor_reset");
    expect(reset).toMatchObject({ targetType: "user", targetId: member.user.id });
    expect(JSON.stringify(own.entries)).not.toContain("member@example.com");

    const platform = await listOperatorActivity(db);
    expect(platform.total).toBe(5);
    expect(platform.entries[0].workspaceName).toBeTruthy();
    const res = await activity(call("GET", "/api/ops/activity", operator.cookie));
    expect((await res.json()).total).toBe(5);
  });

  it("writes nothing for a refused action", async () => {
    const { operator, host } = await world();
    await suspendIt(operator, host.workspaceId, "");
    await reactivate(call("POST", "/x", operator.cookie), ctx({ id: host.workspaceId }));
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});

describe("console data", () => {
  it("lists the suspension on the workspace list and in the detail", async () => {
    const { operator, host } = await world();
    await suspendIt(operator, host.workspaceId, "spam");
    const list = await listOpsWorkspaces(db);
    expect(list.workspaces.find((w) => w.id === host.workspaceId)?.suspendedAt).toBeInstanceOf(Date);
    const info = await getOpsWorkspaceDetail(db, host.workspaceId);
    expect(info).toMatchObject({ suspendedReason: "spam", members: [{ email: "host@example.com", twoFactor: false }] });
  });

  it("reports provider, model and today's calls against the cap, never a key", async () => {
    const { operator } = await world();
    vi.stubEnv("AI_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "sk-secret-value");
    vi.stubEnv("AI_MODEL", "gpt-test");
    vi.stubEnv("AI_GLOBAL_DAILY_CAP", "2");
    await db.insert(aiCalls).values([
      { eventId: null, kind: "analysis", provider: "openai", model: "gpt-test" },
      { eventId: null, kind: "analysis", provider: "openai", model: "gpt-test" },
    ]);
    const res = await aiStatus(call("GET", "/api/ops/ai", operator.cookie));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      provider: "openai",
      model: "gpt-test",
      configured: true,
      callsToday: 2,
      globalDailyCap: 2,
      paused: true,
    });
    expect(text).not.toContain("sk-secret-value");
    expect(await getOpsAiStatus(db, new Date(Date.now() + 2 * 86_400_000))).toMatchObject({ callsToday: 0, paused: false });
  });

  it("lets an operator run the existing AI connection test without a workspace role", async () => {
    const { operator } = await world();
    await db.delete(memberships).where(eq(memberships.userId, operator.user.id));
    vi.stubEnv("AI_PROVIDER", "mock");
    const { POST } = await import("@/app/api/ai/test/route");
    const res = await POST(call("POST", "/api/ai/test", operator.cookie));
    expect(res.status).toBe(200);
    const stranger = await person("host2@example.com");
    await db.delete(memberships).where(eq(memberships.userId, stranger.user.id));
    expect((await POST(call("POST", "/api/ai/test", stranger.cookie))).status).toBe(403);
  });
});
