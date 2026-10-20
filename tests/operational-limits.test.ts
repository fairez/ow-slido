// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiCalls, events, interactions, participants, sharedNotes } from "@/db/schema";
import { getRateLimitStore } from "@/lib/rate-limit";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let analyze: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let zipRoute: { GET: (req: Request, ctx: Ctx) => Promise<Response> };
let signup: (req: Request) => Promise<Response>;
let usage: typeof import("@/lib/ai/usage");
let limits: typeof import("@/lib/workspace-rate-limit");

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  analyze = await import("@/app/api/interactions/[id]/analyze/route");
  zipRoute = await import("@/app/api/events/[id]/export.zip/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
  usage = await import("@/lib/ai/usage");
  limits = await import("@/lib/workspace-rate-limit");
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
});
afterEach(() => vi.unstubAllEnvs());

const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
const req = (method: string, cookie: string, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function host(email: string) {
  const res = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    }),
  );
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const created = await eventsRoute.POST(
    req("POST", cookie, { name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }),
  );
  const eventId = (await created.json()).event.id as string;
  const [{ workspaceId }] = await db.select({ workspaceId: events.workspaceId }).from(events).where(eq(events.id, eventId));
  return { cookie, eventId, workspaceId };
}

async function liveNotes(h: { cookie: string; eventId: string }) {
  const res = await collection.POST(req("POST", h.cookie, { type: "sharedNotes", prompt: "Thoughts?" }), ctx(h.eventId));
  const id = (await res.json()).interaction.id as string;
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, id));
  const [p] = await db.insert(participants).values({ eventId: h.eventId }).returning();
  await db.insert(sharedNotes).values({ interactionId: id, participantId: p.id, text: "one", status: "approved" });
  return id;
}

test("a workspace is stopped at its ceiling with 429 and retryAfter, and others are not", async () => {
  const a = await host("a@example.com");
  const b = await host("b@example.com");
  const call = (h: typeof a) => zipRoute.GET(req("GET", h.cookie), ctx(h.eventId));

  for (let i = 0; i < limits.WORKSPACE_LIMITS.zip.limit; i++) expect((await call(a)).status).toBe(200);
  const blocked = await call(a);
  expect(blocked.status).toBe(429);
  const body = await blocked.json();
  expect(typeof body.error).toBe("string");
  expect(body.retryAfter).toBeGreaterThan(0);
  expect(blocked.headers.get("retry-after")).toBe(String(body.retryAfter));

  expect((await call(b)).status).toBe(200);
});

test("each action keeps its own counter", async () => {
  const request = new Request("http://localhost/api");
  for (let i = 0; i < limits.WORKSPACE_LIMITS.invitation.limit; i++) {
    expect(await limits.workspaceRateLimited(request, "w1", "invitation")).toBeNull();
  }
  expect((await limits.workspaceRateLimited(request, "w1", "invitation"))?.status).toBe(429);
  expect(await limits.workspaceRateLimited(request, "w1", "ai")).toBeNull();
  expect(await limits.workspaceRateLimited(request, "w2", "invitation")).toBeNull();
});

test("AI starts are limited per workspace", async () => {
  const h = await host("ai@example.com");
  await setPlan(db, h.workspaceId, "pro");
  const id = await liveNotes(h);
  const { limit } = limits.WORKSPACE_LIMITS.ai;
  for (let i = 0; i < limit; i++) await getRateLimitStore().hit(`workspace:${h.workspaceId}:ai`, 60_000);

  const res = await analyze.POST(req("POST", h.cookie, { acceptNotice: true }), ctx(id));
  expect(res.status).toBe(429);
  expect((await res.json()).retryAfter).toBeGreaterThan(0);
});

test("the global daily cap pauses every AI start, whatever the workspace plan", async () => {
  vi.stubEnv("AI_GLOBAL_DAILY_CAP", "2");
  const h = await host("cap@example.com");
  await setPlan(db, h.workspaceId, "team");
  const id = await liveNotes(h);
  // Calls of other workspaces and of deleted events count too.
  await db.insert(aiCalls).values([
    { eventId: null, kind: "x", provider: "mock", model: "m" },
    { eventId: null, kind: "x", provider: "mock", model: "m" },
  ]);

  const res = await analyze.POST(req("POST", h.cookie, { acceptNotice: true }), ctx(id));
  expect(res.status).toBe(503);
  const body = await res.json();
  expect(body.reason).toBe("ai_paused");
  expect(body.error).toBe("AI is paused for today");
});

test("below the global cap AI starts go on", async () => {
  vi.stubEnv("AI_GLOBAL_DAILY_CAP", "3");
  const h = await host("below@example.com");
  await setPlan(db, h.workspaceId, "pro");
  const id = await liveNotes(h);
  await db.insert(aiCalls).values({ eventId: null, kind: "x", provider: "mock", model: "m" });
  const res = await analyze.POST(req("POST", h.cookie, { acceptNotice: true }), ctx(id));
  expect(res.status).toBe(202);
});

test("the global counter starts over on a new UTC day", async () => {
  vi.stubEnv("AI_GLOBAL_DAILY_CAP", "2");
  const day = new Date("2026-11-03T12:00:00Z");
  await db.insert(aiCalls).values([
    { eventId: null, kind: "x", provider: "mock", model: "m", createdAt: new Date("2026-11-03T00:00:01Z") },
    { eventId: null, kind: "x", provider: "mock", model: "m", createdAt: new Date("2026-11-03T11:00:00Z") },
  ]);
  await expect(usage.assertAiNotPaused(db, day)).rejects.toBeInstanceOf(usage.AiPausedError);
  await expect(usage.assertAiNotPaused(db, new Date("2026-11-03T23:59:59Z"))).rejects.toBeInstanceOf(usage.AiPausedError);
  await expect(usage.assertAiNotPaused(db, new Date("2026-11-04T00:00:00Z"))).resolves.toBeUndefined();
  await expect(usage.assertAiNotPaused(db, new Date("2026-11-02T12:00:00Z"))).resolves.toBeUndefined();
});

test("a call that is already reserved stops at the global cap", async () => {
  vi.stubEnv("AI_GLOBAL_DAILY_CAP", "1");
  vi.stubEnv("AI_DAILY_CALL_CAP", "50");
  const now = new Date("2026-11-03T12:00:00Z");
  await usage.reserveAiCall({ eventId: null, kind: "k", provider: "mock", model: "m", now });
  await expect(usage.reserveAiCall({ eventId: null, kind: "k", provider: "mock", model: "m", now })).rejects.toMatchObject({
    code: "daily_cap",
  });
});
