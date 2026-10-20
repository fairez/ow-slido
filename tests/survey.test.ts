// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, participants, surveyAnswers, surveySubmissions, workspaces } from "@/db/schema";
import { buildInteractionCsv } from "@/lib/export";
import { interactionModule } from "@/lib/interaction-modules";
import { checkAnswer, validateAnswers } from "@/lib/survey";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
type ItemCtx = { params: Promise<{ id: string; interactionId: string }> };
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let item: { PATCH: (req: Request, ctx: ItemCtx) => Promise<Response> };
let duplicate: { POST: (req: Request, ctx: ItemCtx) => Promise<Response> };
let survey: { POST: (r: Request, c: Ctx) => Promise<Response> };
let surveyJoin: { POST: (r: Request, c: Ctx) => Promise<Response> };
let signup: (req: Request) => Promise<Response>;
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;
let hostCookie: string;
let eventId: string;
let surveyId: string;
let cookie: string;
let published: { name: string; payload: unknown; hostOnly?: boolean }[];

type Q = { id: string; options?: { id: string; text: string }[] };
let q: { pick: Q; many: Q; stars: Q; scale: Q; text: Q };

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  item = await import("@/app/api/events/[id]/interactions/[interactionId]/route");
  duplicate = await import("@/app/api/events/[id]/interactions/[interactionId]/duplicate/route");
  survey = await import("@/app/api/interactions/[id]/survey/route");
  surveyJoin = await import("@/app/api/interactions/[id]/survey/join/route");
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
const itemCtx = (interactionId: string): ItemCtx => ({ params: Promise.resolve({ id: eventId, interactionId }) });

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
const submit = (answers: unknown, c: string | null = cookie, id = surveyId) => survey.POST(req("POST", { answers }, c), ctx(id));
const create = (body: Record<string, unknown>) => collection.POST(req("POST", { type: "survey", ...body }), ctx(eventId));

const questions = [
  { kind: "choice", text: "Favourite?", required: true, options: ["Red", "Green", "Blue"] },
  { kind: "choice", text: "Pick any", multiple: true, options: ["X", "Y", "Z"] },
  { kind: "rating", text: "How good?", required: true },
  { kind: "rating", text: "Out of ten", scale: "numeric10" },
  { kind: "openText", text: "Anything else?" },
];

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  published = [];
  publisher.setPublisher({
    publish: (_e, name, payload, options) => void published.push({ name, payload, hostOnly: options?.hostOnly }),
  });
  hostCookie = await newHost("host@example.com");
  // Survey is not on the Free plan.
  await setPlan(db, (await db.select({ id: workspaces.id }).from(workspaces))[0].id, "pro");
  const ev = await eventsRoute.POST(
    req("POST", { name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }),
  );
  eventId = (await ev.json()).event.id;
  const created = (await (await create({ title: "Feedback", questions })).json()).interaction;
  surveyId = created.id;
  const [pick, many, stars, scale, text] = created.config.questions;
  q = { pick, many, stars, scale, text };
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, surveyId));
  cookie = await join();
  published = [];
});
afterAll(async () => {
  await pool.end();
});

const valid = () => ({ [q.pick.id]: [q.pick.options![1].id], [q.stars.id]: 4 });

test("a survey is created with a title and up to 20 questions of the three kinds, each with an id", async () => {
  const res = await create({ title: "Pulse", questions: questions.slice(0, 3) });
  expect(res.status).toBe(201);
  const { interaction } = await res.json();
  expect(interaction.type).toBe("survey");
  expect(interaction.title).toBe("Pulse");
  expect(interaction.config.questions).toEqual([
    {
      id: expect.any(String),
      kind: "choice",
      text: "Favourite?",
      required: true,
      multiple: false,
      options: [
        { id: expect.any(String), text: "Red" },
        { id: expect.any(String), text: "Green" },
        { id: expect.any(String), text: "Blue" },
      ],
    },
    {
      id: expect.any(String),
      kind: "choice",
      text: "Pick any",
      required: false,
      multiple: true,
      options: expect.any(Array),
    },
    { id: expect.any(String), kind: "rating", text: "How good?", required: true, scale: "stars5" },
  ]);
  expect(interaction.config.questions[0].id).not.toBe(interaction.config.questions[1].id);
});

test("create rejects a bad title, question list, kind, options or scale", async () => {
  const open = { kind: "openText", text: "Why?" };
  const bad: Record<string, unknown>[] = [
    { questions: [open] },
    { title: " ", questions: [open] },
    { title: "t".repeat(201), questions: [open] },
    { title: "T" },
    { title: "T", questions: [] },
    { title: "T", questions: "no" },
    { title: "T", questions: Array.from({ length: 21 }, () => open) },
    { title: "T", questions: [{ kind: "openText", text: "  " }] },
    { title: "T", questions: [{ kind: "openText", text: "q".repeat(201) }] },
    { title: "T", questions: [{ kind: "video", text: "Q" }] },
    { title: "T", questions: [{ kind: "choice", text: "Q", options: ["only"] }] },
    { title: "T", questions: [{ kind: "choice", text: "Q", options: Array.from({ length: 11 }, (_, i) => `o${i}`) }] },
    { title: "T", questions: [{ kind: "choice", text: "Q", options: ["a", "x".repeat(81)] }] },
    { title: "T", questions: [{ kind: "choice", text: "Q" }] },
    { title: "T", questions: [{ kind: "rating", text: "Q", scale: "stars7" }] },
    { title: "T", questions: [{ ...open, required: "yes" }] },
    { title: "T", questions: [null] },
  ];
  for (const body of bad) expect((await create(body)).status, JSON.stringify(body)).toBe(400);
  expect((await create({ title: "T", questions: Array.from({ length: 20 }, () => open) })).status).toBe(201);
});

test("PATCH keeps the questions when only the title changes, and replaces them when sent", async () => {
  const draft = (await (await create({ title: "Old", questions: [{ kind: "openText", text: "Keep" }] })).json()).interaction;
  const renamed = await item.PATCH(req("PATCH", { title: "New" }), itemCtx(draft.id));
  expect(renamed.status).toBe(200);
  const first = (await renamed.json()).interaction;
  expect(first.title).toBe("New");
  expect(first.config.questions).toHaveLength(1);
  const replaced = await item.PATCH(req("PATCH", { questions: [{ kind: "rating", text: "R" }, { kind: "openText", text: "O" }] }), itemCtx(draft.id));
  expect((await replaced.json()).interaction.config.questions.map((x: { kind: string }) => x.kind)).toEqual(["rating", "openText"]);
  expect((await item.PATCH(req("PATCH", { questions: [] }), itemCtx(draft.id))).status).toBe(400);
  expect((await item.PATCH(req("PATCH", { title: "" }), itemCtx(draft.id))).status).toBe(400);
  // A live survey is no longer editable.
  expect((await item.PATCH(req("PATCH", { title: "x" }), itemCtx(surveyId))).status).toBe(409);
});

test("duplicate copies the questions with new question and option ids and no submissions", async () => {
  expect((await submit(valid())).status).toBe(201);
  const res = await duplicate.POST(req("POST"), itemCtx(surveyId));
  expect(res.status).toBe(201);
  const { interaction } = await res.json();
  expect(interaction.state).toBe("draft");
  expect(interaction.config.questions.map((x: { text: string }) => x.text)).toEqual(questions.map((x) => x.text));
  const oldIds = [q.pick, q.many, q.stars, q.scale, q.text].map((x) => x.id);
  const copy = interaction.config.questions;
  expect(copy.filter((x: { id: string }) => oldIds.includes(x.id))).toEqual([]);
  const oldOptionIds = [...q.pick.options!, ...q.many.options!].map((o) => o.id);
  const copyOptionIds = [...copy[0].options, ...copy[1].options].map((o: { id: string }) => o.id);
  expect(copyOptionIds.filter((id: string) => oldOptionIds.includes(id))).toEqual([]);
  expect(await db.select().from(surveySubmissions).where(eq(surveySubmissions.interactionId, interaction.id))).toHaveLength(0);
});

test("stores one submission with an answer per answered question and tells the host sockets only", async () => {
  const res = await submit({ ...valid(), [q.many.id]: [q.many.options![0].id, q.many.options![2].id], [q.text.id]: "  Great talk  " });
  expect(res.status).toBe(201);
  const [submission] = await db.select().from(surveySubmissions);
  const answers = await db.select().from(surveyAnswers).where(eq(surveyAnswers.submissionId, submission.id));
  expect(Object.fromEntries(answers.map((a) => [a.questionId, a.value]))).toEqual({
    [q.pick.id]: [q.pick.options![1].id],
    [q.many.id]: [q.many.options![0].id, q.many.options![2].id],
    [q.stars.id]: 4,
    [q.text.id]: "Great talk",
  });
  const [p] = await db.select().from(participants);
  expect(p.firstResponseAt).not.toBeNull();
  expect(published.map((m) => [m.name, m.hostOnly])).toEqual([["survey:results", true]]);
});

test("a missing required answer is a 400 naming the question, and nothing is stored", async () => {
  const res = await submit({ [q.text.id]: "only this" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.questionId).toBe(q.pick.id);
  expect(body.missing).toEqual([q.pick.id, q.stars.id]);
  expect(body.error).toBe("This question needs an answer");
  // Blank values count as missing too.
  const blank = await submit({ [q.pick.id]: [], [q.stars.id]: null });
  expect((await blank.json()).missing).toEqual([q.pick.id, q.stars.id]);
  expect(await db.select().from(surveySubmissions)).toHaveLength(0);
  expect(published).toEqual([]);
  // The participant can still submit afterwards.
  expect((await submit(valid())).status).toBe(201);
});

test("every answer is checked against its question", async () => {
  const [a, b] = q.pick.options!;
  const cases: [string, unknown][] = [
    [q.pick.id, [a.id, b.id]], // single choice with two picks
    [q.pick.id, "Red"],
    [q.pick.id, ["not-an-option"]],
    [q.many.id, [q.many.options![0].id, q.many.options![0].id]],
    [q.many.id, [q.pick.options![0].id]], // option of another question
    [q.stars.id, 6],
    [q.stars.id, 0],
    [q.stars.id, 3.5],
    [q.stars.id, "4"],
    [q.scale.id, 11],
    [q.text.id, 5],
    [q.text.id, "x".repeat(501)],
  ];
  for (const [id, value] of cases) {
    await getRateLimitStore().reset();
    const res = await submit({ ...valid(), [id]: value });
    expect(res.status, JSON.stringify([id, value])).toBe(400);
    expect((await res.json()).questionId).toBe(id);
  }
  expect(await db.select().from(surveySubmissions)).toHaveLength(0);
  await getRateLimitStore().reset();
  expect((await submit({ ...valid(), [q.scale.id]: 10, [q.stars.id]: 5 })).status).toBe(201);
});

test("answers for a question that is not in the survey, or a body that is not an object, are refused", async () => {
  const res = await submit({ ...valid(), ghost: 1 });
  expect(res.status).toBe(400);
  expect((await res.json()).questionId).toBe("ghost");
  for (const answers of [null, undefined, [], "x", 3]) expect((await submit(answers)).status).toBe(400);
  expect(await db.select().from(surveySubmissions)).toHaveLength(0);
});

test("the profanity filter applies to open text answers", async () => {
  const res = await submit({ ...valid(), [q.text.id]: "this is shit" });
  expect(res.status).toBe(400);
  expect((await res.json()).questionId).toBe(q.text.id);
  expect(await db.select().from(surveySubmissions)).toHaveLength(0);
});

test("a second submission from the same participant is a 409 'Already submitted' and changes nothing", async () => {
  expect((await submit(valid())).status).toBe(201);
  const again = await submit({ ...valid(), [q.stars.id]: 1 });
  expect(again.status).toBe(409);
  expect((await again.json()).error).toBe("Already submitted");
  expect(await db.select().from(surveySubmissions)).toHaveLength(1);
  const answers = await db.select().from(surveyAnswers).where(eq(surveyAnswers.questionId, q.stars.id));
  expect(answers.map((a) => a.value)).toEqual([4]);
});

test("the database refuses a second submission for the same participant", async () => {
  await submit(valid());
  const [row] = await db.select().from(surveySubmissions);
  await expect(db.insert(surveySubmissions).values({ interactionId: row.interactionId, participantId: row.participantId })).rejects.toThrow();
});

test("only accepts a survey while live", async () => {
  for (const state of ["draft", "paused", "closed"] as const) {
    await db.update(interactions).set({ state }).where(eq(interactions.id, surveyId));
    expect((await submit(valid())).status).toBe(409);
  }
  expect(await db.select().from(surveySubmissions)).toHaveLength(0);
});

test("needs a participant of this event and a survey interaction", async () => {
  expect((await submit(valid(), null)).status).toBe(401);
  const other = await collection.POST(req("POST", { type: "rating", prompt: "r" }), ctx(eventId));
  expect((await submit(valid(), cookie, (await other.json()).interaction.id)).status).toBe(404);
  expect((await submit(valid(), cookie, "not-a-uuid")).status).toBe(404);
});

test("checkAnswer and validateAnswers treat blank optional answers as unanswered", () => {
  const optional = { id: "t", kind: "openText" as const, text: "T", required: false };
  expect(checkAnswer(optional, "   ")).toEqual({ ok: true, value: null });
  expect(checkAnswer(optional, undefined)).toEqual({ ok: true, value: null });
  const result = validateAnswers([optional], { t: "" });
  expect(result.ok && result.answers.size).toBe(0);
});

test("the module counts submissions, aggregates answers per question and exports one row per submission", async () => {
  const second = await join();
  const third = await join();
  const [red, green] = q.pick.options!;
  await submit({ [q.pick.id]: [green.id], [q.stars.id]: 4, [q.many.id]: [q.many.options![0].id], [q.scale.id]: 8, [q.text.id]: "First" });
  await new Promise((r) => setTimeout(r, 5));
  await submit({ [q.pick.id]: [green.id], [q.stars.id]: 5 }, second);
  await new Promise((r) => setTimeout(r, 5));
  await submit({ [q.pick.id]: [red.id], [q.stars.id]: 3, [q.text.id]: "Second" }, third);
  const m = interactionModule("survey");
  expect(await m.responseCount(surveyId)).toBe(3);
  const results = (await m.results(surveyId)) as import("@/lib/survey").SurveyResults;
  expect(results).toMatchObject({ total: 3, completed: 1 });
  expect(results.questions[0]).toMatchObject({
    kind: "choice",
    answered: 3,
    options: [
      { text: "Red", count: 1, percent: 33.3 },
      { text: "Green", count: 2, percent: 66.7 },
      { text: "Blue", count: 0, percent: 0 },
    ],
  });
  expect(results.questions[1]).toMatchObject({ kind: "choice", answered: 1, options: [{ count: 1, percent: 100 }, { count: 0 }, { count: 0 }] });
  expect(results.questions[2]).toMatchObject({ kind: "rating", answered: 3, average: 4, distribution: [0, 0, 1, 1, 1] });
  expect(results.questions[3]).toMatchObject({ kind: "rating", scale: "numeric10", answered: 1, average: 8 });
  expect(results.questions[4]).toMatchObject({ kind: "openText", answered: 2, latest: ["Second", "First"] });

  const csv = await buildInteractionCsv("survey", surveyId);
  expect(csv).toBe(
    "section,title,submission,1. Favourite?,2. Pick any,3. How good?,4. Out of ten,5. Anything else?\r\n" +
      "survey,Feedback,1,Green,X,4,8,First\r\n" +
      "survey,Feedback,2,Green,,5,,\r\n" +
      "survey,Feedback,3,Red,,3,,Second\r\n",
  );
  for (const p of await db.select({ id: participants.id }).from(participants)) expect(csv).not.toContain(p.id);
});

test("completed counts submissions that answered every question", async () => {
  await submit({
    [q.pick.id]: [q.pick.options![0].id],
    [q.many.id]: [q.many.options![1].id],
    [q.stars.id]: 5,
    [q.scale.id]: 10,
    [q.text.id]: "All of it",
  });
  await submit(valid(), await join());
  const results = (await interactionModule("survey").results(surveyId)) as import("@/lib/survey").SurveyResults;
  expect(results).toMatchObject({ total: 2, completed: 1 });
});

test("deleting the event cascades to submissions and answers", async () => {
  await submit(valid());
  expect(await db.select().from(surveySubmissions)).toHaveLength(1);
  expect((await db.select().from(surveyAnswers)).length).toBeGreaterThan(0);
  await db.delete(events).where(eq(events.id, eventId));
  expect(await db.select().from(surveySubmissions)).toHaveLength(0);
  expect(await db.select().from(surveyAnswers)).toHaveLength(0);
});

test("deleting a participant removes their submission and its answers", async () => {
  await submit(valid());
  await db.delete(participants);
  expect(await db.select().from(surveySubmissions)).toHaveLength(0);
  expect(await db.select().from(surveyAnswers)).toHaveLength(0);
});

const anonymous = (id = surveyId, c: string | null = null) =>
  surveyJoin.POST(new Request("http://localhost/api", { method: "POST", headers: c ? { cookie: c } : {} }), ctx(id));
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

test("a second submission answers 409 with the already-submitted reason", async () => {
  expect((await submit(valid())).status).toBe(201);
  const again = await submit(valid());
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ reason: "alreadySubmitted" });
});

test("a live survey stays live beside another interaction, in both start orders", async () => {
  const { startInteraction } = await import("@/lib/interaction-state");
  const { getLiveInteraction } = await import("@/lib/live-view");
  const poll = (await (await collection.POST(req("POST", { type: "poll", question: "Q?", options: ["a", "b"] }), ctx(eventId))).json()).interaction;
  const other = (await (await collection.POST(req("POST", { type: "rating", prompt: "r" }), ctx(eventId))).json()).interaction;
  const state = async (id: string) => (await db.select().from(interactions).where(eq(interactions.id, id)))[0].state;

  expect((await startInteraction(eventId, poll.id)).ok).toBe(true);
  expect(await state(surveyId)).toBe("live");
  expect(await state(poll.id)).toBe("live");
  // The participants' live screen is the poll; the survey has its own link.
  expect((await getLiveInteraction(eventId))?.id).toBe(poll.id);

  expect((await startInteraction(eventId, other.id)).ok).toBe(true);
  expect(await state(poll.id)).toBe("paused");
  expect(await state(surveyId)).toBe("live");

  await db.update(interactions).set({ state: "paused" }).where(eq(interactions.id, surveyId));
  expect((await startInteraction(eventId, surveyId)).ok).toBe(true);
  expect(await state(other.id)).toBe("live");
});

test("two live non-survey interactions are still refused by the database", async () => {
  const a = (await (await collection.POST(req("POST", { type: "rating", prompt: "a" }), ctx(eventId))).json()).interaction;
  const b = (await (await collection.POST(req("POST", { type: "rating", prompt: "b" }), ctx(eventId))).json()).interaction;
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, a.id));
  await expect(db.update(interactions).set({ state: "live" }).where(eq(interactions.id, b.id))).rejects.toThrow();
});

test("the survey link creates a participant and a cookie, then reuses it", async () => {
  const first = await anonymous();
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ submitted: false });
  const fresh = cookieOf(first);
  expect(fresh).toMatch(new RegExp(`^${tokens.participantCookieName(eventId)}=`));
  const before = await db.select().from(participants).where(eq(participants.eventId, eventId));

  const again = await anonymous(surveyId, fresh);
  expect(await again.json()).toEqual({ submitted: false });
  expect(await db.select().from(participants).where(eq(participants.eventId, eventId))).toHaveLength(before.length);

  // The cookie it set is enough to submit.
  expect((await submit(valid(), fresh)).status).toBe(201);
  expect(await (await anonymous(surveyId, fresh)).json()).toEqual({ submitted: true });
});

test("the survey link refuses a survey that is not live and anything that is not a survey", async () => {
  await db.update(interactions).set({ state: "paused" }).where(eq(interactions.id, surveyId));
  expect((await anonymous()).status).toBe(409);
  await db.update(interactions).set({ state: "closed" }).where(eq(interactions.id, surveyId));
  expect((await anonymous()).status).toBe(409);
  const rating = (await (await collection.POST(req("POST", { type: "rating", prompt: "r" }), ctx(eventId))).json()).interaction;
  expect((await anonymous(rating.id)).status).toBe(404);
  expect((await anonymous("nope")).status).toBe(404);
  expect(await db.select().from(participants).where(eq(participants.eventId, eventId))).toHaveLength(1);
});

test("the survey page data follows the state and only sends questions while live", async () => {
  const { getSurveyPage } = await import("@/lib/survey-page");
  const token = (c: string) => () => c.split("=").slice(1).join("=");
  const live = await getSurveyPage(surveyId, token(cookie));
  expect(live).toMatchObject({ status: "open", title: "Feedback", eventName: "E", submitted: false });
  expect(live?.status === "open" && live.questions).toHaveLength(5);

  await submit(valid());
  expect(await getSurveyPage(surveyId, token(cookie))).toMatchObject({ status: "open", submitted: true });
  expect(await getSurveyPage(surveyId, () => undefined)).toMatchObject({ status: "open", submitted: false });

  for (const [state, status] of [["draft", "notOpen"], ["paused", "notOpen"], ["closed", "closed"]] as const) {
    await db.update(interactions).set({ state }).where(eq(interactions.id, surveyId));
    const page = await getSurveyPage(surveyId, token(cookie));
    expect(page).toMatchObject({ status, title: "Feedback" });
    expect(page).not.toHaveProperty("questions");
  }
  expect(await getSurveyPage("nope", () => undefined)).toBeNull();
});
