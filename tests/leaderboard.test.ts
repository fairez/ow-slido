// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, participants, quizAnswers, quizScores, users } from "@/db/schema";
import { closeInteraction } from "@/lib/interaction-state";
import {
  MemoryLeaderboardStore,
  getLeaderboardStore,
  rebuildLeaderboard,
  setLeaderboardStore,
} from "@/lib/leaderboard";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
let resetRoute: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let join: (req: Request) => Promise<Response>;
let signup: (req: Request) => Promise<Response>;
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  resetRoute = await import("@/app/api/events/[id]/leaderboard/reset/route");
  join = (await import("@/app/api/join/route")).POST;
  signup = (await import("@/app/api/auth/signup/route")).POST;
  eventsRoute = await import("@/app/api/events/route");
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  setLeaderboardStore(new MemoryLeaderboardStore());
});
afterAll(async () => {
  setLeaderboardStore(null);
  await pool.end();
});

const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

async function seedEvent(email = "host@example.com") {
  const [user] = await db.insert(users).values({ email, passwordHash: "x" }).returning();
  const [event] = await db
    .insert(events)
    .values({
      workspaceId: await workspaceFor(db, user.id),
      ownerId: user.id,
      name: "Quiz night",
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T11:00:00Z"),
      joinCode: "123456",
    })
    .returning();
  return event;
}

const people = async (eventId: string, n: number) =>
  (await db.insert(participants).values(Array.from({ length: n }, () => ({ eventId }))).returning()).map((p) => p.id);

const config = {
  prompt: "Q",
  options: [
    { id: "a", text: "A" },
    { id: "b", text: "B" },
  ],
  correctOptionIds: ["a"],
  timeLimitSeconds: 20,
  points: 1000,
};

/** A live quiz question with these answers: [participantId, points, elapsedMs]. */
let nextPosition = 0;
async function question(eventId: string, answers: [string, number, number][]) {
  const [q] = await db
    .insert(interactions)
    .values({ eventId, type: "quiz", title: "Q", position: nextPosition++, config, state: "live", startedAt: new Date(), deadlineAt: new Date() })
    .returning();
  if (answers.length > 0) {
    await db.insert(quizAnswers).values(
      answers.map(([participantId, points, elapsedMs]) => ({
        interactionId: q.id,
        participantId,
        optionIds: ["a"],
        elapsedMs,
        correct: points > 0,
        points,
      })),
    );
  }
  return q.id;
}

test("store: ranks by points, then by less total time; equal points and time share a rank", async () => {
  const store = new MemoryLeaderboardStore();
  await store.add("e", { participantId: "slow", points: 800, elapsedMs: 9000 });
  await store.add("e", { participantId: "fast", points: 800, elapsedMs: 4000 });
  await store.add("e", { participantId: "top", points: 900, elapsedMs: 15000 });
  await store.add("e", { participantId: "twin-a", points: 100, elapsedMs: 1000 });
  await store.add("e", { participantId: "twin-b", points: 100, elapsedMs: 1000 });
  await store.add("e", { participantId: "zero", points: 0, elapsedMs: 500 });

  const top = await store.top("e", 10);
  expect(top.map((e) => [e.participantId, e.rank])).toEqual([
    ["top", 1],
    ["fast", 2],
    ["slow", 3],
    ["twin-a", 4],
    ["twin-b", 4],
    ["zero", 6],
  ]);
  expect((await store.top("e", 2)).map((e) => e.participantId)).toEqual(["top", "fast"]);
  expect(await store.top("e", 0)).toEqual([]);
  expect(await store.rankOf("e", "slow")).toMatchObject({ rank: 3, points: 800, answeredCount: 1, totalElapsedMs: 9000 });
  expect(await store.rankOf("e", "nobody")).toBeNull();
  expect(await store.size("e")).toBe(6);
});

test("store: totals add up over questions and events stay apart", async () => {
  const store = new MemoryLeaderboardStore();
  await store.add("e1", { participantId: "p", points: 500, elapsedMs: 3000 });
  await store.add("e1", { participantId: "p", points: 700, elapsedMs: 2000 });
  await store.add("e2", { participantId: "p", points: 50, elapsedMs: 100 });
  expect(await store.rankOf("e1", "p")).toMatchObject({ points: 1200, answeredCount: 2, totalElapsedMs: 5000 });
  expect(await store.rankOf("e2", "p")).toMatchObject({ points: 50, answeredCount: 1 });
});

test("store: reset clears one event only", async () => {
  const store = new MemoryLeaderboardStore();
  await store.add("e1", { participantId: "p", points: 5, elapsedMs: 1 });
  await store.add("e2", { participantId: "p", points: 5, elapsedMs: 1 });
  await store.reset("e1");
  expect(await store.top("e1", 5)).toEqual([]);
  expect(await store.size("e2")).toBe(1);
});

test("closing quiz questions accumulates points over the event and persists them", async () => {
  const event = await seedEvent();
  const [ann, ben, cy] = await people(event.id, 3);
  const q1 = await question(event.id, [[ann, 900, 2000], [ben, 600, 8000]]);
  expect((await closeInteraction(event.id, q1)).ok).toBe(true);
  const q2 = await question(event.id, [[ann, 0, 5000], [ben, 800, 3000], [cy, 700, 4000]]);
  expect((await closeInteraction(event.id, q2)).ok).toBe(true);

  const store = getLeaderboardStore();
  expect((await store.top(event.id, 10)).map((e) => [e.participantId, e.points, e.answeredCount, e.rank])).toEqual([
    [ben, 1400, 2, 1],
    [ann, 900, 2, 2],
    [cy, 700, 1, 3],
  ]);
  const rows = await db.select().from(quizScores).where(eq(quizScores.eventId, event.id));
  expect(rows.map((r) => [r.participantId, r.points, r.answeredCount, r.totalElapsedMs]).sort()).toEqual(
    [[ann, 900, 2, 7000], [ben, 1400, 2, 11000], [cy, 700, 1, 4000]].sort(),
  );
});

test("a question that is only paused or live adds nothing, and closing twice counts once", async () => {
  const event = await seedEvent();
  const [ann] = await people(event.id, 1);
  const q = await question(event.id, [[ann, 900, 2000]]);
  expect(await getLeaderboardStore().size(event.id)).toBe(0);
  expect((await closeInteraction(event.id, q)).ok).toBe(true);
  expect((await closeInteraction(event.id, q)).ok).toBe(false);
  expect(await getLeaderboardStore().rankOf(event.id, ann)).toMatchObject({ points: 900, answeredCount: 1 });
  const [row] = await db.select().from(quizScores);
  expect(row).toMatchObject({ points: 900, answeredCount: 1 });
});

test("a late joiner is ranked by the questions they answered", async () => {
  const event = await seedEvent();
  const [early] = await people(event.id, 1);
  const q1 = await question(event.id, [[early, 400, 9000]]);
  await closeInteraction(event.id, q1);
  const [late] = await people(event.id, 1);
  const q2 = await question(event.id, [[early, 300, 9000], [late, 1000, 1000]]);
  await closeInteraction(event.id, q2);

  const store = getLeaderboardStore();
  expect(await store.rankOf(event.id, late)).toMatchObject({ rank: 1, points: 1000, answeredCount: 1 });
  expect(await store.rankOf(event.id, early)).toMatchObject({ rank: 2, points: 700, answeredCount: 2 });
});

test("a participant who joins but never answers is not ranked", async () => {
  const event = await seedEvent();
  const [ann, idle] = await people(event.id, 2);
  await closeInteraction(event.id, await question(event.id, [[ann, 500, 1000]]));
  expect(await getLeaderboardStore().rankOf(event.id, idle)).toBeNull();
});

test("rebuild reads the persisted totals back into an empty store", async () => {
  const event = await seedEvent();
  const [ann, ben] = await people(event.id, 2);
  await closeInteraction(event.id, await question(event.id, [[ann, 900, 2000], [ben, 900, 1000]]));
  const before = await getLeaderboardStore().top(event.id, 10);

  const fresh = new MemoryLeaderboardStore();
  setLeaderboardStore(fresh);
  expect(await fresh.size(event.id)).toBe(0);
  expect(await rebuildLeaderboard()).toBe(2);
  expect(await fresh.top(event.id, 10)).toEqual(before);
  expect(before.map((e) => e.participantId)).toEqual([ben, ann]);
});

test("rebuild replaces what the store held", async () => {
  const event = await seedEvent();
  await getLeaderboardStore().add(event.id, { participantId: "stale", points: 1, elapsedMs: 1 });
  await rebuildLeaderboard();
  expect(await getLeaderboardStore().size(event.id)).toBe(0);
});

test("the host reset endpoint clears the table and the store; the next questions start a new tally", async () => {
  const signupRes = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "password123" }),
    }),
  );
  const cookie = (signupRes.headers.get("set-cookie") ?? "").split(";")[0];
  const created = await eventsRoute.POST(
    new Request("http://localhost/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }),
    }),
  );
  const eventId = (await created.json()).event.id as string;
  const [ann] = await people(eventId, 1);
  await closeInteraction(eventId, await question(eventId, [[ann, 900, 2000]]));
  expect(await getLeaderboardStore().size(eventId)).toBe(1);

  const reset = (c: string | null, id = eventId) =>
    resetRoute.POST(new Request("http://localhost/api", { method: "POST", headers: c ? { cookie: c } : {} }), ctx(id));
  expect((await reset(null)).status).toBe(401);
  expect(await getLeaderboardStore().size(eventId)).toBe(1);

  expect((await reset(cookie)).status).toBe(200);
  expect(await getLeaderboardStore().size(eventId)).toBe(0);
  expect(await db.select().from(quizScores)).toEqual([]);
  // A rebuild after the reset must not bring the scores back.
  await rebuildLeaderboard();
  expect(await getLeaderboardStore().size(eventId)).toBe(0);

  await closeInteraction(eventId, await question(eventId, [[ann, 300, 1000]]));
  expect(await getLeaderboardStore().rankOf(eventId, ann)).toMatchObject({ points: 300, answeredCount: 1 });
});

test("the reset endpoint refuses a stranger", async () => {
  const event = await seedEvent();
  const signupRes = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "stranger@example.com", password: "password123" }),
    }),
  );
  const cookie = (signupRes.headers.get("set-cookie") ?? "").split(";")[0];
  const [ann] = await people(event.id, 1);
  await closeInteraction(event.id, await question(event.id, [[ann, 900, 2000]]));
  const res = await resetRoute.POST(new Request("http://localhost/api", { method: "POST", headers: { cookie } }), ctx(event.id));
  expect(res.status).toBe(404);
  expect(await getLeaderboardStore().size(event.id)).toBe(1);
});

test("a reconnecting participant (same token) keeps nickname and score", async () => {
  const event = await seedEvent();
  const joinReq = (cookie?: string) =>
    join(
      new Request("http://localhost/api/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ code: "123456" }),
      }),
    );
  const first = await joinReq();
  const firstId = (await first.json()).participant.id as string;
  const token = (first.headers.get("set-cookie") ?? "").split(";")[0];
  await db.update(participants).set({ nickname: "Ayu" }).where(eq(participants.id, firstId));
  await closeInteraction(event.id, await question(event.id, [[firstId, 900, 2000]]));

  const again = await joinReq(token);
  expect((await again.json()).participant.id).toBe(firstId);
  expect(await getLeaderboardStore().rankOf(event.id, firstId)).toMatchObject({ rank: 1, points: 900 });
  const [row] = await db.select({ nickname: participants.nickname }).from(participants).where(eq(participants.id, firstId));
  expect(row.nickname).toBe("Ayu");
  expect(await db.select().from(participants)).toHaveLength(1);
});

test("deleting the event cascades to quiz scores", async () => {
  const event = await seedEvent();
  const [ann] = await people(event.id, 1);
  await closeInteraction(event.id, await question(event.id, [[ann, 900, 2000]]));
  expect(await db.select().from(quizScores)).toHaveLength(1);
  await db.delete(events).where(eq(events.id, event.id));
  expect(await db.select().from(quizScores)).toEqual([]);
});

test("deleting a participant removes their score row", async () => {
  const event = await seedEvent();
  const [ann, ben] = await people(event.id, 2);
  await closeInteraction(event.id, await question(event.id, [[ann, 900, 2000], [ben, 800, 2000]]));
  await db.delete(participants).where(eq(participants.id, ann));
  const rows = await db.select().from(quizScores);
  expect(rows.map((r) => r.participantId)).toEqual([ben]);
});

test("the memory store ranks again after a change, and not before", async () => {
  const store = new MemoryLeaderboardStore();
  await store.add("e", { participantId: "a", points: 100, elapsedMs: 1000 });
  await store.add("e", { participantId: "b", points: 200, elapsedMs: 1000 });
  expect((await store.top("e", 5)).map((x) => x.participantId)).toEqual(["b", "a"]);
  expect(await store.rankOf("e", "a")).toMatchObject({ rank: 2, points: 100 });
  // A read after a later add must see it (the ranking is kept between reads).
  await store.add("e", { participantId: "a", points: 150, elapsedMs: 1000 });
  expect(await store.rankOf("e", "a")).toMatchObject({ rank: 1, points: 250 });
  expect((await store.top("e", 5)).map((x) => x.participantId)).toEqual(["a", "b"]);
  await store.reset("e");
  expect(await store.rankOf("e", "a")).toBeNull();
  await store.replaceAll([{ eventId: "e", participantId: "z", points: 5, answeredCount: 1, totalElapsedMs: 1 }]);
  expect(await store.rankOf("e", "z")).toMatchObject({ rank: 1 });
  expect(await store.size("e")).toBe(1);
});
