// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { interactions, participants, wordcloudEntries } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string; interactionId: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: Handler };
let item: { PATCH: Handler };
let duplicate: { POST: Handler };
let words: { POST: Handler; GET: Handler };
let signup: (req: Request) => Promise<Response>;
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;
let hostCookie: string;
let eventId: string;
let cloudId: string;
let cookie: string;
let published: { name: string; payload: unknown }[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  item = await import("@/app/api/events/[id]/interactions/[interactionId]/route");
  duplicate = await import("@/app/api/events/[id]/interactions/[interactionId]/duplicate/route");
  words = await import("@/app/api/interactions/[id]/words/route");
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
const ctx = (id: string, interactionId = id): Ctx => ({ params: Promise.resolve({ id, interactionId }) });

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

const create = async (body: object, c: string | null = hostCookie) => {
  const res = await collection.POST(req("POST", { type: "wordcloud", ...body }, c), ctx(eventId));
  return { res, json: await res.json() };
};

const send = (word: unknown, { c = cookie as string | null, id = cloudId } = {}) =>
  words.POST(req("POST", { word }, c), ctx(id));
const results = async (c: string | null = cookie) => {
  const res = await words.GET(req("GET", undefined, c), ctx(cloudId));
  return { res, json: await res.json() };
};

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  published = [];
  publisher.setPublisher({ publish: (_e, name, payload) => published.push({ name, payload }) });
  hostCookie = await newHost("host@example.com");
  const ev = await eventsRoute.POST(
    req("POST", { name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }),
  );
  eventId = (await ev.json()).event.id;
  const { json } = await create({ prompt: "One word for today?", maxEntriesPerParticipant: 2 });
  cloudId = json.interaction.id;
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, cloudId));
  cookie = await join();
  // Creating the interaction above published a list change; the tests look at response messages only.
  published = [];
});
afterAll(async () => {
  publisher.setPublisher(null);
  await pool.end();
});

test("creates a word cloud with prompt and entry limit", async () => {
  const { res, json } = await create({ prompt: "  Mood?  ", maxEntriesPerParticipant: 5 });
  expect(res.status).toBe(201);
  expect(json.interaction).toMatchObject({
    type: "wordcloud",
    title: "Mood?",
    state: "draft",
    config: { prompt: "Mood?", maxEntriesPerParticipant: 5 },
  });
});

test("validates prompt and entry limit", async () => {
  expect((await create({ prompt: "", maxEntriesPerParticipant: 2 })).res.status).toBe(400);
  expect((await create({ prompt: "x", maxEntriesPerParticipant: 0 })).res.status).toBe(400);
  expect((await create({ prompt: "x", maxEntriesPerParticipant: 6 })).res.status).toBe(400);
  expect((await create({ prompt: "x", maxEntriesPerParticipant: 1.5 })).res.status).toBe(400);
  expect((await create({ prompt: "x" })).res.status).toBe(400);
  expect((await create({ prompt: "x", maxEntriesPerParticipant: 2 }, null)).res.status).toBe(401);
});

test("edits a draft word cloud and duplicates it as a draft", async () => {
  const { json } = await create({ prompt: "Old", maxEntriesPerParticipant: 1 });
  const id = json.interaction.id;
  const patched = await item.PATCH(req("PATCH", { prompt: "New", maxEntriesPerParticipant: 4 }), ctx(eventId, id));
  expect((await patched.json()).interaction).toMatchObject({
    title: "New",
    config: { prompt: "New", maxEntriesPerParticipant: 4 },
  });
  const dup = await duplicate.POST(req("POST"), ctx(eventId, id));
  expect((await dup.json()).interaction).toMatchObject({
    type: "wordcloud",
    state: "draft",
    config: { prompt: "New", maxEntriesPerParticipant: 4 },
  });
});

test("normalizes words (trim, lowercase) and merges identical ones", async () => {
  expect((await send("  Hello ")).status).toBe(201);
  const other = await join();
  expect((await send("HELLO", { c: other })).status).toBe(201);
  expect((await send("world", { c: other })).status).toBe(201);
  const { json } = await results();
  expect(json).toEqual({
    words: [
      { word: "hello", count: 2 },
      { word: "world", count: 1 },
    ],
    total: 3,
  });
  expect(published.at(-1)).toMatchObject({
    name: "wordcloud:words",
    payload: { interactionId: cloudId, total: 3 },
  });
});

test("rejects empty and over-long words", async () => {
  expect((await send("   ")).status).toBe(400);
  expect((await send(42)).status).toBe(400);
  expect((await send("a".repeat(26))).status).toBe(400);
  expect((await send("a".repeat(25))).status).toBe(201);
});

test("a bare Indonesian connector is rejected and does not use up an entry; phrases with real words stay", async () => {
  for (const w of ["dan", "Yang", " di ", "untuk"]) {
    const res = await send(w);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too common/);
  }
  expect(await db.select().from(wordcloudEntries)).toHaveLength(0);
  expect((await send("dan jeda")).status).toBe(201);
  expect((await send("wifi")).status).toBe(201);
  expect((await results()).json.words.map((w: { word: string }) => w.word).sort()).toEqual(["dan jeda", "wifi"]);
});

test("enforces the per-participant entry limit", async () => {
  const first = await send("one");
  expect(await first.json()).toEqual({ ok: true, remaining: 1 });
  expect((await send("two")).status).toBe(201);
  const third = await send("three");
  expect(third.status).toBe(409);
  expect(await db.select().from(wordcloudEntries)).toHaveLength(2);
});

test("stores profane words as hidden and never returns them", async () => {
  expect((await send("Shit")).status).toBe(201);
  const rows = await db.select().from(wordcloudEntries);
  expect(rows).toMatchObject([{ normalizedWord: "shit", hidden: true }]);
  expect((await results()).json).toEqual({ words: [], total: 0 });
  expect(published).toHaveLength(0);
});

test("rejects submissions when not live", async () => {
  await db.update(interactions).set({ state: "closed" }).where(eq(interactions.id, cloudId));
  expect((await send("late")).status).toBe(409);
  await db.update(interactions).set({ state: "draft" }).where(eq(interactions.id, cloudId));
  expect((await send("early")).status).toBe(409);
  expect(await db.select().from(wordcloudEntries)).toHaveLength(0);
});

test("requires a participant cookie and a word cloud interaction", async () => {
  expect((await send("x", { c: null })).status).toBe(401);
  const [poll] = await db
    .insert(interactions)
    .values({ eventId, type: "poll", title: "P", position: 9, state: "draft", config: {} })
    .returning();
  expect((await send("x", { id: poll.id })).status).toBe(404);
});

test("results are limited to the event's participants and owner", async () => {
  expect((await results(null)).res.status).toBe(401);
  expect((await results(hostCookie)).res.status).toBe(200);
  const stranger = await newHost("other@example.com");
  expect((await results(stranger)).res.status).toBe(404);
});

test("submissions are rate limited per participant", async () => {
  for (let i = 0; i < 20; i++) await send("x");
  const res = await send("x");
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).not.toBeNull();
});
