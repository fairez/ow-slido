// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, participants, questionVotes, questions, users } from "@/db/schema";
import { getRateLimitStore } from "@/lib/rate-limit";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<Record<string, string>> };
type Handlers = Record<string, (r: Request, c: Ctx) => Promise<Response>>;
let qaRoute: Handlers;
let listRoute: Handlers;
let oldListRoute: Handlers;
let tokens: typeof import("@/lib/participant-token");
let questionsLib: typeof import("@/lib/questions");
let eventId: string;
let participantId: string;
let guest: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  qaRoute = (await import("@/app/api/events/[id]/qa/route")) as unknown as Handlers;
  listRoute = (await import("@/app/api/interactions/[id]/questions/route")) as unknown as Handlers;
  oldListRoute = (await import("@/app/api/events/[id]/questions/route")) as unknown as Handlers;
  tokens = await import("@/lib/participant-token");
  questionsLib = await import("@/lib/questions");
});

const req = (method: string, cookie: string | null, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (params: Record<string, string>): Ctx => ({ params: Promise.resolve(params) });

type State = "draft" | "live" | "paused" | "closed";
let nextPosition = 0;
const addQa = async (title: string, state: State, config: Record<string, unknown> = {}) =>
  (
    await db
      .insert(interactions)
      .values({
        eventId,
        type: "qa",
        title,
        state,
        position: nextPosition++,
        config: { prompt: `Prompt of ${title}`, moderation: "open", ...config },
      })
      .returning()
  )[0].id;

const addQuestion = async (interactionId: string, text: string, status: "pending" | "approved" = "approved") =>
  (await db.insert(questions).values({ eventId, interactionId, participantId, text, status }).returning())[0].id;

const view = async () => questionsLib.getParticipantQa(eventId, participantId);

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  nextPosition = 0;
  const [user] = await db.insert(users).values({ email: "h@example.com", passwordHash: "x" }).returning();
  const [event] = await db
    .insert(events)
    .values({
      workspaceId: await workspaceFor(db, user.id),
      ownerId: user.id,
      name: "Town hall",
      joinCode: "123456",
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T12:00:00Z"),
    })
    .returning();
  eventId = event.id;
  const [p] = await db.insert(participants).values({ eventId }).returning();
  participantId = p.id;
  guest = `${tokens.participantCookieName(eventId)}=${tokens.createParticipantToken(eventId, p.id)}`;
});

afterAll(async () => {
  await pool.end();
});

test("an event with no Q&A has nothing to show", async () => {
  expect(await view()).toEqual({ current: null, earlier: [] });
});

test("an event whose Q&As are all drafts is not open yet, and the event-level path refuses a question", async () => {
  await addQa("Not yet", "draft");
  expect(await view()).toEqual({ current: null, earlier: [], notOpen: true });
  const postRoute = (await import("@/app/api/events/[id]/questions/route")) as unknown as Handlers;
  const res = await postRoute.POST(req("POST", guest, { text: "Too early" }), ctx({ id: eventId }));
  expect(res.status).toBe(409);
  expect(await db.select().from(questions)).toHaveLength(0);
  expect(await db.select().from(interactions)).toHaveLength(1);
});

test("the live Q&A is shown with its prompt and approved questions only; drafts are never shown", async () => {
  const older = await addQa("Older", "closed");
  const live = await addQa("Now", "live");
  await addQa("Not yet", "draft");
  await addQuestion(live, "Approved one");
  await addQuestion(live, "Waiting", "pending");
  await addQuestion(older, "Old question");
  const result = await view();
  expect(result.current).toMatchObject({ id: live, title: "Now", prompt: "Prompt of Now", state: "live" });
  expect(result.current?.questions.map((q) => q.text)).toEqual(["Approved one"]);
  expect(result.earlier.map((q) => q.id)).toEqual([older]);
  expect(result.earlier[0].questions.map((q) => q.text)).toEqual(["Old question"]);
});

test("with none live, the latest closed or paused one is current and the other closed ones are earlier, newest first", async () => {
  const oldest = await addQa("Oldest", "closed");
  const middle = await addQa("Middle", "closed");
  const latest = await addQa("Latest", "paused");
  const result = await view();
  expect(result.current).toMatchObject({ id: latest, state: "paused" });
  expect(result.earlier.map((q) => q.id)).toEqual([middle, oldest]);
});

test("a closed current Q&A is not repeated under earlier questions", async () => {
  const first = await addQa("First", "closed");
  const last = await addQa("Last", "closed");
  const result = await view();
  expect(result.current?.id).toBe(last);
  expect(result.earlier.map((q) => q.id)).toEqual([first]);
});

test("a paused Q&A is not listed as earlier while another is live", async () => {
  await addQa("Paused", "paused");
  const live = await addQa("Live", "live");
  const result = await view();
  expect(result.current?.id).toBe(live);
  expect(result.earlier).toEqual([]);
});

test("upvoted reflects this participant", async () => {
  const live = await addQa("Live", "live");
  const id = await addQuestion(live, "Mine");
  await db.insert(questionVotes).values({ questionId: id, participantId });
  const [other] = await db.insert(participants).values({ eventId }).returning();
  expect((await view()).current?.questions[0]).toMatchObject({ upvotes: 1, upvoted: true });
  expect((await questionsLib.getParticipantQa(eventId, other.id)).current?.questions[0]).toMatchObject({
    upvotes: 1,
    upvoted: false,
  });
});

test("GET /api/events/[id]/qa answers a participant, refuses a stranger and an unknown id", async () => {
  const live = await addQa("Live", "live");
  await addQuestion(live, "Hello");
  const ok = await qaRoute.GET(req("GET", guest), ctx({ id: eventId }));
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ current: { id: live, questions: [{ text: "Hello" }] }, earlier: [] });
  expect((await qaRoute.GET(req("GET", null), ctx({ id: eventId }))).status).toBe(401);
  expect((await qaRoute.GET(req("GET", guest), ctx({ id: "nope" }))).status).toBe(404);
});

test("the old event-level list still answers with the live Q&A's questions", async () => {
  await addQa("Closed", "closed");
  const live = await addQa("Live", "live");
  await addQuestion(live, "On the old path");
  const res = await oldListRoute.GET(req("GET", guest), ctx({ id: eventId }));
  expect(((await res.json()) as { questions: { text: string }[] }).questions.map((q) => q.text)).toEqual([
    "On the old path",
  ]);
});

test("a closed Q&A refuses new questions; a paused or live one takes them", async () => {
  const closed = await addQa("Closed", "closed");
  const paused = await addQa("Paused", "paused");
  const live = await addQa("Live", "live");
  const ask = (id: string) => listRoute.POST(req("POST", guest, { text: "Hello there" }), ctx({ id }));
  const refused = await ask(closed);
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("This Q&A is closed");
  expect((await ask(paused)).status).toBe(201);
  expect((await ask(live)).status).toBe(201);
  expect(await db.select().from(questions).where(eq(questions.interactionId, closed))).toHaveLength(0);
});

test("the first question of an event with no Q&A creates a live one when nothing else is live", async () => {
  const res = await oldListRoute.POST(req("POST", guest, { text: "First ever" }), ctx({ id: eventId }));
  expect(res.status).toBe(201);
  const rows = await db.select().from(interactions).where(eq(interactions.eventId, eventId));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ type: "qa", state: "live" });
  expect((await view()).current).toMatchObject({ id: rows[0].id, state: "live" });
});

test("the created Q&A is paused when another interaction is live", async () => {
  await db.insert(interactions).values({ eventId, type: "poll", title: "P", state: "live", position: 0, config: {} });
  await oldListRoute.POST(req("POST", guest, { text: "During a poll" }), ctx({ id: eventId }));
  const [qa] = await db.select().from(interactions).where(eq(interactions.type, "qa"));
  expect(qa.state).toBe("paused");
});
