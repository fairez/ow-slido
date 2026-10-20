// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, participants, quizAnswers, quizScores, users } from "@/db/schema";
import { closeInteraction } from "@/lib/interaction-state";
import { MemoryLeaderboardStore, setLeaderboardStore } from "@/lib/leaderboard";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
let route: { GET: (req: Request, ctx: Ctx) => Promise<Response> };
let session: typeof import("@/lib/auth/session");
let standings: typeof import("@/lib/leaderboard/standings");
let quiz: typeof import("@/lib/quiz");
let exporter: typeof import("@/lib/export");
let modules: typeof import("@/lib/interaction-modules");
let hostCookie: string;
let strangerCookie: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  route = await import("@/app/api/events/[id]/leaderboard/route");
  session = await import("@/lib/auth/session");
  standings = await import("@/lib/leaderboard/standings");
  quiz = await import("@/lib/quiz");
  exporter = await import("@/lib/export");
  modules = await import("@/lib/interaction-modules");
});

beforeEach(async () => {
  await truncateAll(db);
  setLeaderboardStore(new MemoryLeaderboardStore());
});
afterAll(async () => {
  setLeaderboardStore(null);
  await pool.end();
});

const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

async function seedEvent() {
  const [host, stranger] = await db
    .insert(users)
    .values([
      { email: "host@example.com", passwordHash: "x" },
      { email: "stranger@example.com", passwordHash: "x" },
    ])
    .returning();
  await workspaceFor(db, stranger.id);
  hostCookie = `${session.SESSION_COOKIE}=${session.createSessionToken(host.id)}`;
  strangerCookie = `${session.SESSION_COOKIE}=${session.createSessionToken(stranger.id)}`;
  const [event] = await db
    .insert(events)
    .values({
      workspaceId: await workspaceFor(db, host.id),
      ownerId: host.id,
      name: "Quiz night",
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T11:00:00Z"),
      joinCode: "123456",
    })
    .returning();
  return event;
}

const people = async (eventId: string, nicknames: (string | null)[]) =>
  (await db.insert(participants).values(nicknames.map((nickname) => ({ eventId, nickname }))).returning()).map((p) => p.id);

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

let nextPosition = 0;
/** A live quiz question with these answers: [participantId, points, elapsedMs]; points 0 means a wrong answer. */
async function question(eventId: string, title: string, answers: [string, number, number][]) {
  const [q] = await db
    .insert(interactions)
    .values({ eventId, type: "quiz", title, position: nextPosition++, config, state: "live", startedAt: new Date(), deadlineAt: new Date() })
    .returning();
  await db.insert(quizAnswers).values(
    answers.map(([participantId, points, elapsedMs]) => ({
      interactionId: q.id,
      participantId,
      optionIds: [points > 0 ? "a" : "b"],
      elapsedMs,
      correct: points > 0,
      points,
    })),
  );
  return q.id;
}

async function twoQuestions() {
  const event = await seedEvent();
  const [ann, ben, nameless] = await people(event.id, ["Ann", "=Ben", null]);
  const q1 = await question(event.id, "First", [[ann, 900, 2000], [ben, 600, 8000], [nameless, 0, 3000]]);
  await closeInteraction(event.id, q1);
  const q2 = await question(event.id, "Second", [[ann, 0, 5000], [ben, 800, 3000], [nameless, 700, 4000]]);
  await closeInteraction(event.id, q2);
  return { event, ann, ben, nameless, q1, q2 };
}

test("topStandings gives rank, nickname and points; a participant without a name has a null nickname", async () => {
  const { event } = await twoQuestions();
  expect(await standings.topStandings(event.id, 10)).toEqual([
    { rank: 1, nickname: "=Ben", points: 1400 },
    { rank: 2, nickname: "Ann", points: 900 },
    { rank: 3, nickname: null, points: 700 },
  ]);
  expect((await standings.topStandings(event.id, 2)).length).toBe(2);
});

test("a closed quiz question on the presenter carries the top 10, a live one does not", async () => {
  const { q2, event } = await twoQuestions();
  const [row] = await db.select().from(interactions).where((await import("drizzle-orm")).eq(interactions.id, q2));
  const closed = await modules.interactionModule("quiz").presenter(row);
  expect(closed && closed.type === "quiz" && closed.leaderboard?.map((s) => s.rank)).toEqual([1, 2, 3]);

  const [live] = await db
    .insert(interactions)
    .values({ eventId: event.id, type: "quiz", title: "Third", position: nextPosition++, config, state: "live", startedAt: new Date(), deadlineAt: new Date() })
    .returning();
  const state = await modules.interactionModule("quiz").presenter(live);
  expect(state && state.type === "quiz" && state.leaderboard).toBeNull();
});

test("a participant's outcome has their own rank and total, and null before they are ranked", async () => {
  const { q2, ann, nameless, event } = await twoQuestions();
  expect((await quiz.getQuizOutcome(q2, ann))?.standing).toEqual({ rank: 2, points: 900, players: 3 });
  expect((await quiz.getQuizOutcome(q2, nameless))?.standing).toMatchObject({ rank: 3, points: 700 });
  const [late] = await people(event.id, ["Late"]);
  expect((await quiz.getQuizOutcome(q2, late))?.standing).toBeNull();
});

test("the event CSV lists the leaderboard once, with a fallback name, and the ZIP file of the first quiz carries it", async () => {
  const { event } = await twoQuestions();
  const csv = await exporter.buildEventCsv(event.id);
  const lines = csv.trim().split("\r\n");
  const at = lines.indexOf("section,rank,nickname,points,correct_answers");
  expect(at).toBeGreaterThan(-1);
  // A nickname that starts with a formula character is neutralised by the CSV writer.
  expect(lines.slice(at + 1)).toEqual(["leaderboard,1,'=Ben,1400,2", "leaderboard,2,Ann,900,1", "leaderboard,3,Player,700,1"]);
  expect(csv.split("section,rank,nickname").length).toBe(2);

  const [first, second] = await db.select().from(interactions).orderBy(interactions.position);
  expect(await exporter.buildInteractionCsv("quiz", first.id)).toContain("leaderboard,1,");
  expect(await exporter.buildInteractionCsv("quiz", second.id)).not.toContain("leaderboard");
});

test("no nickname appears in any other export table", async () => {
  const { event } = await twoQuestions();
  const csv = await exporter.buildEventCsv(event.id);
  const [head] = csv.split("section,rank,nickname");
  expect(head).not.toContain("Ann");
  expect(head).not.toContain("Player");
});

test("correct answers are counted per participant when a question closes", async () => {
  const { event, ann, ben } = await twoQuestions();
  const rows = await db.select().from(quizScores);
  const correct = Object.fromEntries(rows.map((r) => [r.participantId, r.correctCount]));
  expect(correct[ann]).toBe(1);
  expect(correct[ben]).toBe(2);
  expect((await standings.allStandings(event.id)).map((s) => s.correct)).toEqual([2, 1, 1]);
});

test("the leaderboard route is for the host's workspace and caps the limit at 10", async () => {
  const { event } = await twoQuestions();
  const url = (q = "") => `http://localhost/api/events/${event.id}/leaderboard${q}`;
  const get = (q: string, cookie: string | null) => route.GET(new Request(url(q), { headers: cookie ? { cookie } : {} }), ctx(event.id));

  expect((await get("", null)).status).toBe(401);
  expect((await get("", strangerCookie)).status).toBe(404);

  const all = (await (await get("", hostCookie)).json()) as { standings: unknown[]; players: number };
  expect(all.standings.length).toBe(3);
  expect(all.players).toBe(3);
  expect(JSON.stringify(all)).not.toMatch(/participantId/);

  const three = (await (await get("?limit=2", hostCookie)).json()) as { standings: unknown[] };
  expect(three.standings.length).toBe(2);
  const capped = (await (await get("?limit=500", hostCookie)).json()) as { standings: unknown[] };
  expect(capped.standings.length).toBe(3);
});
