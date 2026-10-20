// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, participants, quizAnswers, users, workspaces } from "@/db/schema";
import { interactionModule } from "@/lib/interaction-modules";
import { quizConfigError } from "@/lib/interaction-config";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
type ItemCtx = { params: Promise<{ id: string; interactionId: string }> };
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let item: { PATCH: (req: Request, ctx: ItemCtx) => Promise<Response> };
let duplicate: { POST: (req: Request, ctx: ItemCtx) => Promise<Response> };
let start: { POST: (req: Request, ctx: ItemCtx) => Promise<Response> };
let pause: { POST: (req: Request, ctx: ItemCtx) => Promise<Response> };
let signup: (req: Request) => Promise<Response>;
let hostCookie: string;
let eventId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  item = await import("@/app/api/events/[id]/interactions/[interactionId]/route");
  duplicate = await import("@/app/api/events/[id]/interactions/[interactionId]/duplicate/route");
  start = await import("@/app/api/events/[id]/interactions/[interactionId]/start/route");
  pause = await import("@/app/api/events/[id]/interactions/[interactionId]/pause/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
});

const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", cookie: hostCookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
const itemCtx = (interactionId: string): ItemCtx => ({ params: Promise.resolve({ id: eventId, interactionId }) });

const options = [
  { id: "a", text: "Jakarta" },
  { id: "b", text: "Bandung" },
  { id: "c", text: "Surabaya" },
];
const good = { prompt: "Capital of Indonesia?", options, correctOptionIds: ["a"] };
const create = (body: Record<string, unknown>) => collection.POST(req("POST", { type: "quiz", ...body }), ctx(eventId));

beforeEach(async () => {
  await truncateAll(db);
  const res = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "host@example.com", password: "password123" }),
    }),
  );
  hostCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  await db.update(users).set({ emailVerifiedAt: new Date() });
  // Quiz is not on the Free plan.
  await setPlan(db, (await db.select({ id: workspaces.id }).from(workspaces))[0].id, "pro");
  const ev = await eventsRoute.POST(
    req("POST", { name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }),
  );
  eventId = (await ev.json()).event.id;
});
afterAll(async () => {
  await pool.end();
});

test("creates a quiz question with defaults for time limit and points", async () => {
  const res = await create(good);
  expect(res.status).toBe(201);
  const { interaction } = await res.json();
  expect(interaction).toMatchObject({
    type: "quiz",
    title: "Capital of Indonesia?",
    state: "draft",
    startedAt: null,
    deadlineAt: null,
    config: { prompt: "Capital of Indonesia?", options, correctOptionIds: ["a"], timeLimitSeconds: 20, points: 1000 },
  });
});

test("accepts several correct options, a time limit and points", async () => {
  const res = await create({ ...good, correctOptionIds: ["a", "c"], timeLimitSeconds: 5, points: 500 });
  expect(res.status).toBe(201);
  expect((await res.json()).interaction.config).toMatchObject({ correctOptionIds: ["a", "c"], timeLimitSeconds: 5, points: 500 });
});

test.each([
  ["prompt over 200 characters", { prompt: "x".repeat(201) }],
  ["a missing prompt", { prompt: "" }],
  ["one option", { options: [options[0]] }],
  ["seven options", { options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, text: `O${i}` })), correctOptionIds: ["o0"] }],
  ["an empty option", { options: [options[0], { id: "z", text: " " }] }],
  ["an option over 80 characters", { options: [options[0], { id: "z", text: "x".repeat(81) }] }],
  ["no correct option", { correctOptionIds: [] }],
  ["a missing correctOptionIds", { correctOptionIds: undefined }],
  ["a correct id that is not an option", { correctOptionIds: ["zzz"] }],
  ["a repeated correct id", { correctOptionIds: ["a", "a"] }],
  ["a time limit of 4", { timeLimitSeconds: 4 }],
  ["a time limit of 121", { timeLimitSeconds: 121 }],
  ["a fractional time limit", { timeLimitSeconds: 10.5 }],
  ["zero points", { points: 0 }],
])("rejects %s", async (_name, change) => {
  const res = await create({ ...good, ...change });
  expect(res.status).toBe(400);
  expect(await db.select().from(interactions).where(eq(interactions.type, "quiz"))).toHaveLength(0);
});

test("accepts the limits: 2 and 6 options, 5 and 120 seconds", async () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, text: `O${i}` }));
  expect((await create({ ...good, options: options.slice(0, 2), timeLimitSeconds: 5 })).status).toBe(201);
  expect((await create({ prompt: "Six", options: six, correctOptionIds: ["o5"], timeLimitSeconds: 120 })).status).toBe(201);
});

test("PATCH edits a draft and checks the correct ids against the merged options", async () => {
  const id = (await (await create(good)).json()).interaction.id;
  const ok = await item.PATCH(req("PATCH", { timeLimitSeconds: 30, points: 2000 }), itemCtx(id));
  expect(ok.status).toBe(200);
  expect((await ok.json()).interaction.config).toMatchObject({ timeLimitSeconds: 30, points: 2000, correctOptionIds: ["a"] });

  // Removing the correct option without restating the correct ids leaves a stale id.
  const stale = await item.PATCH(req("PATCH", { options: [options[1], options[2]] }), itemCtx(id));
  expect(stale.status).toBe(400);
  const fixed = await item.PATCH(req("PATCH", { options: [options[1], options[2]], correctOptionIds: ["b"] }), itemCtx(id));
  expect(fixed.status).toBe(200);
  const unknownCorrect = await item.PATCH(req("PATCH", { correctOptionIds: ["a"] }), itemCtx(id));
  expect(unknownCorrect.status).toBe(400);
  expect((await db.select().from(interactions).where(eq(interactions.id, id)))[0].config).toMatchObject({
    options: [options[1], options[2]],
    correctOptionIds: ["b"],
  });
});

test("quizConfigError flags a config whose correct ids are not options", () => {
  expect(quizConfigError({ options, correctOptionIds: ["a"] })).toBeNull();
  expect(quizConfigError({ options, correctOptionIds: [] })).toMatchObject({ error: "api.quizCorrectRequired" });
  expect(quizConfigError({ options, correctOptionIds: ["x"] })).toMatchObject({ error: "api.quizCorrectInvalid" });
});

test("duplicating gives the copy new option ids and keeps the correct answers pointing at the same texts", async () => {
  const id = (await (await create({ ...good, correctOptionIds: ["a", "c"] })).json()).interaction.id;
  const res = await duplicate.POST(req("POST"), itemCtx(id));
  expect(res.status).toBe(201);
  const { interaction } = await res.json();
  const config = interaction.config as { options: { id: string; text: string }[]; correctOptionIds: string[] };
  expect(config.options.map((o) => o.text)).toEqual(["Jakarta", "Bandung", "Surabaya"]);
  expect(config.options.map((o) => o.id)).not.toContain("a");
  expect(config.correctOptionIds.map((cid) => config.options.find((o) => o.id === cid)?.text)).toEqual(["Jakarta", "Surabaya"]);
  expect(interaction).toMatchObject({ state: "draft", startedAt: null, deadlineAt: null });
});

test("starting a quiz question stores started_at and a deadline of the time limit later", async () => {
  const id = (await (await create({ ...good, timeLimitSeconds: 30 })).json()).interaction.id;
  const before = Date.now();
  const res = await start.POST(req("POST"), itemCtx(id));
  expect(res.status).toBe(200);
  const [row] = await db.select().from(interactions).where(eq(interactions.id, id));
  expect(row.state).toBe("live");
  expect(row.startedAt).not.toBeNull();
  expect(row.deadlineAt!.getTime() - row.startedAt!.getTime()).toBe(30_000);
  // The database clock and this process agree to within a few seconds.
  expect(Math.abs(row.startedAt!.getTime() - before)).toBeLessThan(5_000);
});

test("resuming a paused quiz question opens a fresh window; other types keep null", async () => {
  const id = (await (await create({ ...good, timeLimitSeconds: 5 })).json()).interaction.id;
  await start.POST(req("POST"), itemCtx(id));
  const [first] = await db.select().from(interactions).where(eq(interactions.id, id));
  await new Promise((r) => setTimeout(r, 20));
  await pause.POST(req("POST"), itemCtx(id));
  await start.POST(req("POST"), itemCtx(id));
  const [again] = await db.select().from(interactions).where(eq(interactions.id, id));
  expect(again.startedAt!.getTime()).toBeGreaterThan(first.startedAt!.getTime());
  expect(again.deadlineAt!.getTime() - again.startedAt!.getTime()).toBe(5_000);

  const rating = (await (await collection.POST(req("POST", { type: "rating", prompt: "r" }), ctx(eventId))).json()).interaction.id;
  await start.POST(req("POST"), itemCtx(rating));
  const [plain] = await db.select().from(interactions).where(eq(interactions.id, rating));
  expect(plain.state).toBe("live");
  expect(plain.startedAt).toBeNull();
  expect(plain.deadlineAt).toBeNull();
});

test("the quiz module validates, counts answers and is not on the Free plan", async () => {
  const m = interactionModule("quiz");
  expect(m.validateConfig(good, false)).toMatchObject({ ok: true });
  expect(m.validateConfig({ ...good, correctOptionIds: [] }, false)).toMatchObject({ ok: false });

  const id = (await (await create(good)).json()).interaction.id;
  expect(await m.responseCount(id)).toBe(0);
  const [p] = await db.insert(participants).values({ eventId }).returning();
  await db.insert(quizAnswers).values({ interactionId: id, participantId: p.id, optionIds: ["a"], elapsedMs: 1200, correct: true, points: 900 });
  expect(await m.responseCount(id)).toBe(1);

  const [workspace] = await db.select({ id: workspaces.id }).from(workspaces);
  await setPlan(db, workspace.id, "free");
  expect((await create(good)).status).toBe(402);
});

test("a participant answers once per question", async () => {
  const id = (await (await create(good)).json()).interaction.id;
  const [p] = await db.insert(participants).values({ eventId }).returning();
  const row = { interactionId: id, participantId: p.id, optionIds: ["a"], elapsedMs: 10, correct: true, points: 1000 };
  await db.insert(quizAnswers).values(row);
  await expect(db.insert(quizAnswers).values(row)).rejects.toThrow();
});

test("deleting the event cascades to quiz answers", async () => {
  const id = (await (await create(good)).json()).interaction.id;
  const [p] = await db.insert(participants).values({ eventId }).returning();
  await db.insert(quizAnswers).values({ interactionId: id, participantId: p.id, optionIds: ["b"], elapsedMs: 10, correct: false, points: 0 });
  expect(await db.select().from(quizAnswers)).toHaveLength(1);
  await db.delete(events).where(eq(events.id, eventId));
  expect(await db.select().from(quizAnswers)).toHaveLength(0);
});

test("deleting a participant removes their quiz answers", async () => {
  const id = (await (await create(good)).json()).interaction.id;
  const [p] = await db.insert(participants).values({ eventId }).returning();
  await db.insert(quizAnswers).values({ interactionId: id, participantId: p.id, optionIds: ["a"], elapsedMs: 10, correct: true, points: 1000 });
  await db.delete(participants).where(eq(participants.id, p.id));
  expect(await db.select().from(quizAnswers)).toHaveLength(0);
});
