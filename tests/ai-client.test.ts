// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiCalls, events } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ai = typeof import("@/lib/ai");
let ai: Ai;
let signup: (req: Request) => Promise<Response>;
let statusRoute: { GET: (r: Request) => Promise<Response> };
let testRoute: { POST: (r: Request) => Promise<Response> };
let hostCookie: string;
let eventId: string;

const noSleep = { sleep: async () => {} };
const schema: import("@/lib/ai").AiSchema<{ summary: string }> = {
  name: "s",
  jsonSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  parse: (v) =>
    typeof (v as { summary?: unknown })?.summary === "string"
      ? { ok: true, value: { summary: (v as { summary: string }).summary } }
      : { ok: false, error: "summary missing" },
};

const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  ai = await import("@/lib/ai");
  signup = (await import("@/app/api/auth/signup/route")).POST;
  statusRoute = await import("@/app/api/ai/status/route");
  testRoute = await import("@/app/api/ai/test/route");
});

beforeEach(async () => {
  await truncateAll(db);
  for (const k of ["AI_PROVIDER", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AI_MODEL", "AI_EVENT_CALL_CAP", "AI_DAILY_CALL_CAP"]) {
    delete process.env[k];
  }
  const res = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "host@example.com", password: "correct horse battery" }),
    }),
  );
  hostCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const [user] = await db.query.users.findMany();
  const [event] = await db
    .insert(events)
    .values({ ownerId: user.id, name: "E", startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000), joinCode: "234567" })
    .returning();
  eventId = event.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await pool.end();
});

test("not configured without a provider or key", async () => {
  expect(ai.isAiConfigured()).toBe(false);
  process.env.AI_PROVIDER = "openai";
  expect(ai.isAiConfigured()).toBe(false);
  await expect(ai.complete([], schema)).rejects.toMatchObject({ code: "not_configured" });
  process.env.OPENAI_API_KEY = "sk-test";
  expect(ai.isAiConfigured()).toBe(true);
});

test("mock provider is deterministic and satisfies the schema", async () => {
  process.env.AI_PROVIDER = "mock";
  const a = await ai.complete([{ role: "user", content: "x" }], schema);
  const b = await ai.complete([{ role: "user", content: "y" }], schema);
  expect(a).toEqual(b);
  expect(typeof a.summary).toBe("string");
});

test("openai request shape, key header and model", async () => {
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.AI_MODEL = "m1";
  const fetchMock = vi.fn(async () => reply('{"summary":"hi"}'));
  vi.stubGlobal("fetch", fetchMock);
  expect(await ai.complete([{ role: "user", content: "hello" }], schema)).toEqual({ summary: "hi" });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.openai.com/v1/chat/completions");
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  const body = JSON.parse(init.body as string);
  expect(body.model).toBe("m1");
  expect(body.response_format).toEqual({ type: "json_object" });
});

test("openrouter uses its own endpoint and key", async () => {
  process.env.AI_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "or-test";
  const fetchMock = vi.fn(async () => reply('{"summary":"hi"}'));
  vi.stubGlobal("fetch", fetchMock);
  await ai.complete([], schema);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer or-test");
});

test("retries 429 and 5xx, then succeeds; gives up after three attempts", async () => {
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test";
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 429 }))
    .mockResolvedValueOnce(new Response("", { status: 503 }))
    .mockResolvedValueOnce(reply('{"summary":"ok"}'));
  vi.stubGlobal("fetch", fetchMock);
  expect(await ai.complete([], schema, { http: noSleep })).toEqual({ summary: "ok" });
  expect(fetchMock).toHaveBeenCalledTimes(3);

  const failing = vi.fn(async () => new Response("", { status: 500 }));
  vi.stubGlobal("fetch", failing);
  await expect(ai.complete([], schema, { http: noSleep })).rejects.toMatchObject({ code: "provider" });
  expect(failing).toHaveBeenCalledTimes(3);
});

test("does not retry a 4xx", async () => {
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test";
  const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(ai.complete([], schema, { http: noSleep })).rejects.toMatchObject({ code: "provider" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("invalid output gets one repair retry, then fails", async () => {
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test";
  const repairs = vi.fn().mockResolvedValueOnce(reply("not json")).mockResolvedValueOnce(reply('{"summary":"fixed"}'));
  vi.stubGlobal("fetch", repairs);
  expect(await ai.complete([], schema)).toEqual({ summary: "fixed" });
  expect(repairs).toHaveBeenCalledTimes(2);

  const bad = vi.fn(async () => reply('{"nope":1}'));
  vi.stubGlobal("fetch", bad);
  await expect(ai.complete([], schema)).rejects.toMatchObject({ code: "invalid_output" });
  expect(bad).toHaveBeenCalledTimes(2);
  // A repair is part of the same call: it does not use a second slot of the cap.
  expect(await db.select().from(aiCalls)).toHaveLength(2);
});

test("times out a hung request", async () => {
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test";
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ),
  );
  await expect(ai.complete([], schema, { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
});

test("per-event cap is enforced and persisted", async () => {
  process.env.AI_PROVIDER = "mock";
  process.env.AI_EVENT_CALL_CAP = "2";
  await ai.complete([], schema, { eventId });
  await ai.complete([], schema, { eventId });
  await expect(ai.complete([], schema, { eventId })).rejects.toMatchObject({ code: "event_cap" });
  expect(await db.select().from(aiCalls).where(eq(aiCalls.eventId, eventId))).toHaveLength(2);
});

test("per-day cap is enforced across events", async () => {
  process.env.AI_PROVIDER = "mock";
  process.env.AI_DAILY_CALL_CAP = "2";
  await ai.complete([], schema, { eventId });
  await ai.complete([], schema);
  await expect(ai.complete([], schema, { eventId })).rejects.toMatchObject({ code: "daily_cap" });
});

test("deleting an event keeps the daily count", async () => {
  process.env.AI_PROVIDER = "mock";
  process.env.AI_DAILY_CALL_CAP = "1";
  await ai.complete([], schema, { eventId });
  await db.delete(events).where(eq(events.id, eventId));
  const rows = await db.select().from(aiCalls);
  expect(rows).toHaveLength(1);
  expect(rows[0].eventId).toBeNull();
  await expect(ai.complete([], schema)).rejects.toMatchObject({ code: "daily_cap" });
});

test("errors and stored rows never contain the key or message text", async () => {
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-secret-key";
  vi.stubGlobal("fetch", vi.fn(async () => new Response("echo sk-secret-key my private note", { status: 500 })));
  const err = await ai.complete([{ role: "user", content: "my private note" }], schema, { http: noSleep }).catch((e) => e);
  expect(String(err.message)).not.toMatch(/sk-secret-key|private note/);
  expect(JSON.stringify(await db.select().from(aiCalls))).not.toMatch(/sk-secret-key|private note/);
});

const adminReq = (method: string, cookie: string | null = hostCookie) =>
  new Request("http://localhost/api/ai", { method, headers: cookie ? { cookie } : {} });

test("GET /api/ai/status is admin-only and omits the key", async () => {
  expect((await statusRoute.GET(adminReq("GET", null))).status).toBe(401);
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-secret-key";
  process.env.AI_MODEL = "m1";
  const res = await statusRoute.GET(adminReq("GET"));
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ provider: "openai", model: "m1", configured: true });
  expect(text).not.toContain("sk-secret-key");
});

test("GET /api/ai/status reports unconfigured", async () => {
  const body = await (await statusRoute.GET(adminReq("GET"))).json();
  expect(body).toEqual({ provider: null, model: null, configured: false });
});

test("POST /api/ai/test makes one call, requires admin, maps errors", async () => {
  expect((await testRoute.POST(adminReq("POST", null))).status).toBe(401);
  expect((await testRoute.POST(adminReq("POST"))).status).toBe(503);

  process.env.AI_PROVIDER = "mock";
  const res = await testRoute.POST(adminReq("POST"));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, provider: "mock", configured: true });
  expect(await db.select().from(aiCalls)).toHaveLength(1);

  process.env.AI_DAILY_CALL_CAP = "1";
  expect((await testRoute.POST(adminReq("POST"))).status).toBe(429);
});
