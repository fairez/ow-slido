// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { interactions, participants, quizAnswers, workspaces } from "@/db/schema";
import { isCorrectSelection, quizGraceMs, scoreQuizAnswer } from "@/lib/quiz";
import { interactionModule } from "@/lib/interaction-modules";
import { buildInteractionCsv } from "@/lib/export";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let answer: { POST: (r: Request, c: Ctx) => Promise<Response> };
let signup: (req: Request) => Promise<Response>;
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;
let hostCookie: string;
let eventId: string;
let quizId: string;
let cookie: string;
let published: { name: string; payload: unknown; hostOnly?: boolean }[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  answer = await import("@/app/api/interactions/[id]/quiz-answer/route");
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

const join = async () => {
  const [p] = await db.insert(participants).values({ eventId }).returning();
  return { id: p.id, cookie: `${tokens.participantCookieName(eventId)}=${tokens.createParticipantToken(eventId, p.id)}` };
};
const post = (optionIds: unknown, c: string | null = cookie, id = quizId) =>
  answer.POST(req("POST", { optionIds }, c), ctx(id));

/** Puts the question `agoMs` into its window, as if it had started that long ago. */
const startedAgo = (agoMs: number, limitSeconds = 20) =>
  db
    .update(interactions)
    .set({
      state: "live",
      startedAt: sql`now() - make_interval(secs => ${agoMs / 1000})`,
      deadlineAt: sql`now() - make_interval(secs => ${agoMs / 1000}) + make_interval(secs => ${limitSeconds})`,
    })
    .where(eq(interactions.id, quizId));

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  published = [];
  publisher.setPublisher({
    publish: (_e, name, payload, options) => void published.push({ name, payload, hostOnly: options?.hostOnly }),
  });
  const res = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "host@example.com", password: "password123" }),
    }),
  );
  hostCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  await setPlan(db, (await db.select({ id: workspaces.id }).from(workspaces))[0].id, "pro");
  const ev = await eventsRoute.POST(
    req("POST", { name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }),
  );
  eventId = (await ev.json()).event.id;
  const created = await collection.POST(
    req("POST", {
      type: "quiz",
      prompt: "Which are Indonesian islands?",
      options: [
        { id: "a", text: "Java" },
        { id: "b", text: "Bali" },
        { id: "c", text: "Honshu" },
      ],
      correctOptionIds: ["a", "b"],
      timeLimitSeconds: 20,
      points: 1000,
    }),
    ctx(eventId),
  );
  quizId = (await created.json()).interaction.id;
  await startedAgo(0);
  cookie = (await join()).cookie;
  published = [];
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await pool.end();
});

test("scoreQuizAnswer: 0 when wrong, full points at 0%, 75% at 50%, half at the deadline", () => {
  const base = { timeLimitMs: 20_000, points: 1000 };
  expect(scoreQuizAnswer({ ...base, correct: false, elapsedMs: 0 })).toBe(0);
  expect(scoreQuizAnswer({ ...base, correct: true, elapsedMs: 0 })).toBe(1000);
  expect(scoreQuizAnswer({ ...base, correct: true, elapsedMs: 10_000 })).toBe(750);
  expect(scoreQuizAnswer({ ...base, correct: true, elapsedMs: 20_000 })).toBe(500);
});

test("scoreQuizAnswer clamps time outside the window (grace answers earn the 50%)", () => {
  const base = { correct: true, timeLimitMs: 20_000, points: 1000 };
  expect(scoreQuizAnswer({ ...base, elapsedMs: 20_250 })).toBe(500);
  expect(scoreQuizAnswer({ ...base, elapsedMs: -5 })).toBe(1000);
});

test("isCorrectSelection needs the same set, in any order", () => {
  expect(isCorrectSelection(["b", "a"], ["a", "b"])).toBe(true);
  expect(isCorrectSelection(["a"], ["a", "b"])).toBe(false);
  expect(isCorrectSelection(["a", "b", "c"], ["a", "b"])).toBe(false);
  expect(isCorrectSelection(["c"], ["a", "b"])).toBe(false);
});

test("a correct answer is stored with the server's elapsed time and points", async () => {
  await startedAgo(10_000);
  const res = await post(["b", "a"]);
  expect(res.status).toBe(201);
  const [row] = await db.select().from(quizAnswers);
  expect(row).toMatchObject({ interactionId: quizId, optionIds: ["b", "a"], correct: true });
  expect(row.elapsedMs).toBeGreaterThanOrEqual(10_000);
  expect(row.elapsedMs).toBeLessThan(11_000);
  expect(row.points).toBeGreaterThan(740);
  expect(row.points).toBeLessThanOrEqual(750);
  const [p] = await db.select().from(participants);
  expect(p.firstResponseAt).not.toBeNull();
});

test("selecting only part of the correct set, or a wrong option, scores 0", async () => {
  const other = await join();
  expect((await post(["a"])).status).toBe(201);
  expect((await post(["a", "c"], other.cookie)).status).toBe(201);
  const rows = await db.select().from(quizAnswers);
  expect(rows.map((r) => [r.correct, r.points])).toEqual([
    [false, 0],
    [false, 0],
  ]);
});

test("one answer per participant: the second is 409 and changes nothing", async () => {
  expect((await post(["a", "b"])).status).toBe(201);
  const again = await post(["c"]);
  expect(again.status).toBe(409);
  expect((await db.select().from(quizAnswers)).map((r) => r.optionIds)).toEqual([["a", "b"]]);
});

test("after the deadline the answer is 409 'Time is up' and nothing is stored", async () => {
  await startedAgo(21_000);
  const res = await post(["a", "b"]);
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("Time is up");
  expect(await db.select().from(quizAnswers)).toHaveLength(0);
});

test("an answer inside the 300 ms grace still counts, at half points", async () => {
  await startedAgo(20_100);
  const res = await post(["a", "b"]);
  expect(res.status).toBe(201);
  expect((await db.select().from(quizAnswers))[0].points).toBe(500);
});

test("the grace period is configurable with QUIZ_GRACE_MS", async () => {
  expect(quizGraceMs()).toBe(300);
  vi.stubEnv("QUIZ_GRACE_MS", "50");
  expect(quizGraceMs()).toBe(50);
  await startedAgo(20_100);
  expect((await post(["a", "b"])).status).toBe(409);
  vi.stubEnv("QUIZ_GRACE_MS", "2000");
  expect((await post(["a", "b"])).status).toBe(201);
  vi.stubEnv("QUIZ_GRACE_MS", "junk");
  expect(quizGraceMs()).toBe(300);
});

test("a resumed question opens a fresh window", async () => {
  await startedAgo(30_000);
  expect((await post(["a"])).status).toBe(409);
  await startedAgo(1_000);
  expect((await post(["a"])).status).toBe(201);
});

test("only a live question takes answers", async () => {
  for (const state of ["draft", "paused", "closed"] as const) {
    await db.update(interactions).set({ state }).where(eq(interactions.id, quizId));
    expect((await post(["a"])).status).toBe(409);
  }
  expect(await db.select().from(quizAnswers)).toHaveLength(0);
});

test.each([
  ["no option", []],
  ["an unknown option", ["zzz"]],
  ["a repeated option", ["a", "a"]],
  ["a non-array", "a"],
  ["a number in the list", [1]],
  ["nothing", undefined],
])("rejects %s with 400", async (_name, optionIds) => {
  expect((await post(optionIds)).status).toBe(400);
  expect(await db.select().from(quizAnswers)).toHaveLength(0);
});

test("needs a participant token for this event, and a quiz id", async () => {
  expect((await post(["a"], null)).status).toBe(401);
  expect((await post(["a"], "participant_other=bad")).status).toBe(401);
  expect((await post(["a"], cookie, "not-a-uuid")).status).toBe(404);
  await db.update(interactions).set({ type: "poll" }).where(eq(interactions.id, quizId));
  expect((await post(["a"])).status).toBe(404);
});

test("results count each selected option and the correct share; they go to the host only", async () => {
  const p2 = await join();
  const p3 = await join();
  await post(["a", "b"]);
  await post(["a"], p2.cookie);
  await post(["c"], p3.cookie);
  const msg = published.filter((m) => m.name === "quiz:results").at(-1)!;
  expect(msg.hostOnly).toBe(true);
  const results = (msg.payload as { results: Record<string, unknown> }).results;
  expect(results).toMatchObject({
    interactionId: quizId,
    total: 3,
    correctPercent: 33,
    options: [
      { id: "a", text: "Java", correct: true, count: 2 },
      { id: "b", text: "Bali", correct: true, count: 1 },
      { id: "c", text: "Honshu", correct: false, count: 1 },
    ],
  });
  expect(await interactionModule("quiz").results(quizId)).toEqual(results);
  expect(await interactionModule("quiz").responseCount(quizId)).toBe(3);
});

test("results before any answer have no correct percentage", async () => {
  const results = (await interactionModule("quiz").results(quizId)) as { total: number; correctPercent: number | null };
  expect(results.total).toBe(0);
  expect(results.correctPercent).toBeNull();
});

test("the CSV lists options with counts and correct share, without participants", async () => {
  await post(["a", "b"]);
  const p2 = await join();
  await post(["c"], p2.cookie);
  const csv = await buildInteractionCsv("quiz", quizId);
  expect(csv).toContain("section,title,option,correct,count,answers,correct_percent");
  expect(csv).toContain("quiz,Which are Indonesian islands?,Java,yes,1,2,50");
  expect(csv).toContain("quiz,Which are Indonesian islands?,Honshu,no,1,2,50");
  expect(csv).not.toContain(p2.id);
});
