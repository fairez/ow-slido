// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, participants, pollVotes, users } from "@/db/schema";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";
import { AUDIENCE_IP_LIMIT } from "@/lib/rate-limit";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
let vote: (req: Request, ctx: Ctx) => Promise<Response>;
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;
let eventId: string;
let pollId: string;
let participantId: string;
let cookie: string;
let published: { eventId: string; name: string; payload: unknown }[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  vote = (await import("@/app/api/interactions/[id]/vote/route")).POST;
  tokens = await import("@/lib/participant-token");
  publisher = await import("@/lib/realtime/publisher");
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

const newPoll = async (state: "draft" | "live" | "closed", multiSelect = false, position = 0) => {
  const [row] = await db
    .insert(interactions)
    .values({
      eventId,
      type: "poll",
      title: "Lunch?",
      state,
      position,
      config: {
        options: [
          { id: "a", label: "Pizza" },
          { id: "b", label: "Tacos" },
          { id: "c", label: "Salad" },
        ],
        multiSelect,
        showResultsToParticipants: false,
      },
    })
    .returning();
  return row.id;
};

const join = async () => {
  const [p] = await db.insert(participants).values({ eventId }).returning();
  return { id: p.id, cookie: `${tokens.participantCookieName(eventId)}=${tokens.createParticipantToken(eventId, p.id)}` };
};

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  published = [];
  publisher.setPublisher({ publish: (e, name, payload) => published.push({ eventId: e, name, payload }) });
  const [user] = await db.insert(users).values({ email: "host@example.com", passwordHash: "x" }).returning();
  const [event] = await db
    .insert(events)
    .values({
      workspaceId: await workspaceFor(db, user.id), ownerId: user.id,
      name: "Town hall",
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T11:00:00Z"),
      joinCode: "123456",
    })
    .returning();
  eventId = event.id;
  pollId = await newPoll("live");
  ({ id: participantId, cookie } = await join());
});
afterAll(async () => {
  publisher.setPublisher(null);
  await pool.end();
});

const call = (optionIds: unknown, { id = pollId, c = cookie as string | null } = {}) =>
  vote(
    new Request(`http://localhost/api/interactions/${id}/vote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
      body: JSON.stringify({ optionIds }),
    }),
    { params: Promise.resolve({ id }) },
  );

test("records a valid vote, sets first_response_at and publishes counts", async () => {
  const res = await call(["b"]);
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ counts: { a: 0, b: 1, c: 0 }, total: 1 });
  const [p] = await db.select().from(participants).where(eq(participants.id, participantId));
  expect(p.firstResponseAt).not.toBeNull();
  expect(published).toEqual([
    { eventId, name: "poll:counts", payload: { interactionId: pollId, counts: { a: 0, b: 1, c: 0 }, total: 1 } },
  ]);
});

test("multi-select polls accept several options", async () => {
  const id = await newPoll("closed", true, 1);
  await db.update(interactions).set({ state: "closed" }).where(eq(interactions.id, pollId));
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, id));
  const res = await call(["a", "c"], { id });
  expect(res.status).toBe(201);
  expect((await res.json()).counts).toEqual({ a: 1, b: 0, c: 1 });
});

test("a second vote is rejected with 409 and not counted", async () => {
  expect((await call(["a"])).status).toBe(201);
  expect((await call(["b"])).status).toBe(409);
  expect(await db.select().from(pollVotes)).toHaveLength(1);
  expect(published).toHaveLength(1);
});

test("a closed or draft poll rejects votes with 409", async () => {
  await db.update(interactions).set({ state: "closed" }).where(eq(interactions.id, pollId));
  expect((await call(["a"])).status).toBe(409);
  const draft = await newPoll("draft", false, 1);
  expect((await call(["a"], { id: draft })).status).toBe(409);
  expect(await db.select().from(pollVotes)).toHaveLength(0);
});

test("rejects options that do not belong to the poll", async () => {
  expect((await call(["zzz"])).status).toBe(400);
  expect((await call([])).status).toBe(400);
  expect((await call("a")).status).toBe(400);
  expect(await db.select().from(pollVotes)).toHaveLength(0);
});

test("single-select polls reject several options", async () => {
  expect((await call(["a", "b"])).status).toBe(400);
  expect(await db.select().from(pollVotes)).toHaveLength(0);
});

test("requires a participant cookie for the interaction's event", async () => {
  expect((await call(["a"], { c: null })).status).toBe(401);
  expect((await call(["a"], { id: "not-a-uuid" })).status).toBe(404);
  expect((await call(["a"], { id: crypto.randomUUID() })).status).toBe(404);
});

test("votes are rate limited per participant token", async () => {
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await call(["zzz"])).status;
  expect(last).toBe(429);
  const other = await join();
  expect((await call(["a"], { c: other.cookie })).status).toBe(201);
});

test("votes are rate limited per IP", async () => {
  let last: Response | undefined;
  for (let i = 0; i < AUDIENCE_IP_LIMIT + 1; i++) {
    last = await vote(
      new Request(`http://localhost/api/interactions/${pollId}/vote`, {
        method: "POST",
        headers: { "x-forwarded-for": "9.9.9.9" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: pollId }) },
    );
  }
  expect(last!.status).toBe(429);
  expect(last!.headers.get("Retry-After")).not.toBeNull();
});
