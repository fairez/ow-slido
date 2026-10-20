// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, openTextResponses, participants } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let responses: { POST: (r: Request, c: Ctx) => Promise<Response>; GET: (r: Request, c: Ctx) => Promise<Response> };
let one: { PATCH: (r: Request, c: Ctx) => Promise<Response>; DELETE: (r: Request, c: Ctx) => Promise<Response> };
let signup: (req: Request) => Promise<Response>;
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;
let hostCookie: string;
let eventId: string;
let openId: string;
let cookie: string;
let published: { name: string; payload: unknown }[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  responses = await import("@/app/api/interactions/[id]/responses/route");
  one = await import("@/app/api/responses/[id]/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
  tokens = await import("@/lib/participant-token");
  publisher = await import("@/lib/realtime/publisher");
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

const req = (method: string, body?: unknown, c: string | null = hostCookie) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

async function newHost(email: string) {
  const res = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    }),
  );
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

const join = async () => {
  const [p] = await db.insert(participants).values({ eventId }).returning();
  return `${tokens.participantCookieName(eventId)}=${tokens.createParticipantToken(eventId, p.id)}`;
};
const post = (text: unknown, c: string | null = cookie, id = openId) =>
  responses.POST(req("POST", { text }, c), ctx(id));
const listAs = async (c: string | null) => {
  const res = await responses.GET(req("GET", undefined, c), ctx(openId));
  return { status: res.status, body: (await res.json()) as { responses: { id: string; text: string; hidden?: boolean; highlighted: boolean }[] } };
};
const firstId = async () => (await db.select().from(openTextResponses))[0].id;

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  published = [];
  publisher.setPublisher({ publish: (_e, name, payload) => void published.push({ name, payload }) });
  hostCookie = await newHost("host@example.com");
  const ev = await eventsRoute.POST(
    req("POST", { name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }),
  );
  eventId = (await ev.json()).event.id;
  const res = await collection.POST(
    req("POST", { type: "openText", prompt: "What surprised you?", maxResponsesPerParticipant: 2 }),
    ctx(eventId),
  );
  openId = (await res.json()).interaction.id;
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, openId));
  cookie = await join();
  // Creating the interaction above published a list change; the tests look at response messages only.
  published = [];
});
afterAll(async () => {
  await pool.end();
});

test("submits a trimmed response, sets first_response_at and publishes", async () => {
  const res = await post("  Nice  ");
  expect(res.status).toBe(201);
  expect((await res.json()).response).toMatchObject({ text: "Nice", highlighted: false });
  expect(published.map((p) => p.name)).toEqual(["response:added"]);
  const [p] = await db.select().from(participants);
  expect(p.firstResponseAt).not.toBeNull();
});

test("rejects empty and over-long text", async () => {
  expect((await post("")).status).toBe(400);
  expect((await post("   ")).status).toBe(400);
  expect((await post(5)).status).toBe(400);
  expect((await post("x".repeat(301))).status).toBe(400);
  expect((await post("x".repeat(300))).status).toBe(201);
});

test("blocks profanity", async () => {
  const res = await post("what the fuck");
  expect(res.status).toBe(400);
  expect(await db.select().from(openTextResponses)).toHaveLength(0);
});

test("enforces maxResponsesPerParticipant per participant", async () => {
  expect((await post("one")).status).toBe(201);
  expect((await post("two")).status).toBe(201);
  expect((await post("three")).status).toBe(409);
  expect((await post("mine", await join())).status).toBe(201);
});

test("only accepts responses while live", async () => {
  await db.update(interactions).set({ state: "closed" }).where(eq(interactions.id, openId));
  expect((await post("late")).status).toBe(409);
  await db.update(interactions).set({ state: "draft" }).where(eq(interactions.id, openId));
  expect((await post("early")).status).toBe(409);
});

test("requires a joined participant of that event and an open-text interaction", async () => {
  expect((await post("hi", null)).status).toBe(401);
  expect((await post("hi", "participant_x=bad")).status).toBe(401);
  expect((await post("hi", cookie, "nope")).status).toBe(404);
  expect((await post("hi", cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
});

test("is rate limited per participant", async () => {
  await db.update(interactions).set({ config: { prompt: "p", maxResponsesPerParticipant: 3 } }).where(eq(interactions.id, openId));
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await post("a")).status;
  expect(last).toBe(429);
});

test("lists newest first and hides hidden responses from participants", async () => {
  await post("first");
  await new Promise((r) => setTimeout(r, 5));
  await post("second");
  const mid = (await db.select().from(openTextResponses).where(eq(openTextResponses.text, "first")))[0].id;
  expect((await listAs(cookie)).body.responses.map((r) => r.text)).toEqual(["second", "first"]);

  expect((await one.PATCH(req("PATCH", { hidden: true }), ctx(mid))).status).toBe(200);
  const audience = await listAs(cookie);
  expect(audience.body.responses.map((r) => r.text)).toEqual(["second"]);
  expect(JSON.stringify(audience.body)).not.toContain("participant");

  const host = await listAs(hostCookie);
  expect(host.body.responses.map((r) => [r.text, r.hidden])).toEqual([["second", false], ["first", true]]);
  expect((await listAs(null)).status).toBe(401);
});

test("host highlights, hides and deletes, publishing each change", async () => {
  await post("hello");
  const id = await firstId();
  published = [];

  const hl = await one.PATCH(req("PATCH", { highlighted: true }), ctx(id));
  expect((await hl.json()).response.highlighted).toBe(true);
  expect(published.map((p) => p.name)).toEqual(["response:updated"]);

  await one.PATCH(req("PATCH", { hidden: true }), ctx(id));
  expect((await db.select().from(openTextResponses))[0]).toMatchObject({ hidden: true, highlighted: false });
  expect(published.map((p) => p.name)).toEqual(["response:updated", "response:removed"]);

  await one.PATCH(req("PATCH", { hidden: false }), ctx(id));
  expect(published.at(-1)?.name).toBe("response:added");

  expect((await one.DELETE(req("DELETE"), ctx(id))).status).toBe(204);
  expect(await db.select().from(openTextResponses)).toHaveLength(0);
  expect(published.at(-1)?.name).toBe("response:removed");
});

test("validates host changes", async () => {
  await post("hello");
  const id = await firstId();
  expect((await one.PATCH(req("PATCH", {}), ctx(id))).status).toBe(400);
  expect((await one.PATCH(req("PATCH", { hidden: "yes" }), ctx(id))).status).toBe(400);
  expect((await one.PATCH(req("PATCH", { hidden: true }), ctx("not-a-uuid"))).status).toBe(404);
});

test("only the owning host can change or delete, and participants cannot", async () => {
  await post("hello");
  const id = await firstId();
  const other = await newHost("other@example.com");
  expect((await one.PATCH(req("PATCH", { hidden: true }, other), ctx(id))).status).toBe(404);
  expect((await one.DELETE(req("DELETE", undefined, other), ctx(id))).status).toBe(404);
  expect((await one.PATCH(req("PATCH", { hidden: true }, null), ctx(id))).status).toBe(401);
  expect((await one.DELETE(req("DELETE", undefined, cookie), ctx(id))).status).toBe(401);
  expect((await responses.GET(req("GET", undefined, other), ctx(openId))).status).toBe(404);
  expect((await db.select().from(openTextResponses))[0].hidden).toBe(false);
});

test("deleting the event cascades to responses", async () => {
  await post("hello");
  await db.delete(events).where(eq(events.id, eventId));
  expect(await db.select().from(openTextResponses)).toHaveLength(0);
});
