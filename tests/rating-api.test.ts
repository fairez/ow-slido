// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, ratingResponses, participants } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let rating: { POST: (r: Request, c: Ctx) => Promise<Response>; GET: (r: Request, c: Ctx) => Promise<Response> };
let signup: (req: Request) => Promise<Response>;
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;
let hostCookie: string;
let eventId: string;
let ratingId: string;
let cookie: string;
let published: { name: string; payload: unknown }[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  rating = await import("@/app/api/interactions/[id]/rating/route");
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
const post = (value: unknown, c: string | null = cookie, id = ratingId) =>
  rating.POST(req("POST", { value }, c), ctx(id));
const get = async (c: string | null) => {
  const res = await rating.GET(req("GET", undefined, c), ctx(ratingId));
  return { status: res.status, body: await res.json() };
};
const setConfig = (scale: string) =>
  db.update(interactions).set({ config: { prompt: "p", scale } }).where(eq(interactions.id, ratingId));

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
  const res = await collection.POST(req("POST", { type: "rating", prompt: "How was it?" }), ctx(eventId));
  ratingId = (await res.json()).interaction.id;
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, ratingId));
  cookie = await join();
  // Creating the interaction above published a list change; the tests look at response messages only.
  published = [];
});
afterAll(async () => {
  await pool.end();
});

test("stores a star rating, sets first_response_at and publishes results", async () => {
  const res = await post(4);
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.value).toBe(4);
  expect(body.results).toMatchObject({ scale: "stars5", total: 1, average: 4, distribution: [0, 0, 0, 1, 0] });
  expect(published.map((p) => p.name)).toEqual(["rating:results"]);
  const [p] = await db.select().from(participants);
  expect(p.firstResponseAt).not.toBeNull();
});

test("stars5 rejects values outside 1-5 and non-integers", async () => {
  for (const v of [0, 6, -1, 2.5, "3", null, undefined]) expect((await post(v)).status).toBe(400);
  expect(await db.select().from(ratingResponses)).toHaveLength(0);
  expect((await post(1)).status).toBe(201);
});

test("numeric10 accepts 1-10 and rejects 11 and 0", async () => {
  await setConfig("numeric10");
  expect((await post(11)).status).toBe(400);
  expect((await post(0)).status).toBe(400);
  expect((await post(10)).status).toBe(201);
  const { body } = await get(cookie);
  expect(body.results.distribution).toHaveLength(10);
  expect(body.results.distribution[9]).toBe(1);
});

test("a second rating from the same participant is a 409 and changes nothing", async () => {
  expect((await post(5)).status).toBe(201);
  expect((await post(1)).status).toBe(409);
  const rows = await db.select().from(ratingResponses);
  expect(rows).toHaveLength(1);
  expect(rows[0].value).toBe(5);
});

test("only accepts ratings while live", async () => {
  await db.update(interactions).set({ state: "closed" }).where(eq(interactions.id, ratingId));
  expect((await post(3)).status).toBe(409);
  await db.update(interactions).set({ state: "draft" }).where(eq(interactions.id, ratingId));
  expect((await post(3)).status).toBe(409);
});

test("requires a joined participant of that event and a rating interaction", async () => {
  expect((await post(3, null)).status).toBe(401);
  expect((await post(3, "participant_x=bad")).status).toBe(401);
  expect((await post(3, cookie, "nope")).status).toBe(404);
  expect((await post(3, cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
});

test("aggregates average, total and distribution across participants", async () => {
  for (const v of [5, 4, 4, 1]) await post(v, await join());
  const { status, body } = await get(cookie);
  expect(status).toBe(200);
  expect(body.results).toMatchObject({ total: 4, average: 3.5, distribution: [1, 0, 0, 2, 1] });
  expect(body.mine).toBeNull();
  published = [];
  await post(2, cookie);
  expect((await get(cookie)).body.mine).toBe(2);
  expect(published[0].payload).toMatchObject({ results: { total: 5, average: 3.2 } });
});

test("results have a null average before any rating", async () => {
  const { body } = await get(cookie);
  expect(body.results).toMatchObject({ total: 0, average: null, distribution: [0, 0, 0, 0, 0] });
});

test("results: closed stays readable, draft hidden from participants, host sees any state", async () => {
  await post(3);
  await db.update(interactions).set({ state: "closed" }).where(eq(interactions.id, ratingId));
  expect((await get(cookie)).status).toBe(200);
  await db.update(interactions).set({ state: "draft" }).where(eq(interactions.id, ratingId));
  expect((await get(cookie)).status).toBe(404);
  const host = await get(hostCookie);
  expect(host.status).toBe(200);
  expect(host.body.results.total).toBe(1);
  expect((await get(null)).status).toBe(401);
  expect((await get(await newHost("other@example.com"))).status).toBe(404);
});

test("is rate limited per participant", async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await post(3)).status;
  expect(last).toBe(429);
});

test("deleting the event cascades to ratings", async () => {
  await post(3);
  expect(await db.select().from(ratingResponses)).toHaveLength(1);
  await db.delete(events).where(eq(events.id, eventId));
  expect(await db.select().from(ratingResponses)).toHaveLength(0);
});
