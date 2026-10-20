// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, participants, questions, users } from "@/db/schema";
import { getRateLimitStore } from "@/lib/rate-limit";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<Record<string, string>> };
type Handlers = Record<string, (r: Request, c: Ctx) => Promise<Response>>;
let listRoute: Handlers;
let queueRoute: Handlers;
let itemRoute: Handlers;
let upvoteRoute: Handlers;
let oldListRoute: Handlers;
let oldItemRoute: Handlers;
let oldModerationRoute: Handlers;
let oldPresentRoute: Handlers;
let oldUpvoteRoute: Handlers;
let eventRoute: Handlers;
let session: typeof import("@/lib/auth/session");
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let hostCookie: string;
let eventId: string;
let first: string;
let second: string;
let guest: string;
let published: { name: string; payload: unknown; hostOnly?: boolean }[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  listRoute = (await import("@/app/api/interactions/[id]/questions/route")) as unknown as Handlers;
  queueRoute = (await import("@/app/api/interactions/[id]/questions/queue/route")) as unknown as Handlers;
  itemRoute = (await import("@/app/api/interactions/[id]/questions/[questionId]/route")) as unknown as Handlers;
  upvoteRoute = (await import("@/app/api/interactions/[id]/questions/[questionId]/upvote/route")) as unknown as Handlers;
  oldListRoute = (await import("@/app/api/events/[id]/questions/route")) as unknown as Handlers;
  oldItemRoute = (await import("@/app/api/events/[id]/questions/[questionId]/route")) as unknown as Handlers;
  oldModerationRoute = (await import("@/app/api/events/[id]/moderation/route")) as unknown as Handlers;
  oldPresentRoute = (await import("@/app/api/events/[id]/present/questions/route")) as unknown as Handlers;
  oldUpvoteRoute = (await import("@/app/api/questions/[id]/upvote/route")) as unknown as Handlers;
  eventRoute = (await import("@/app/api/events/[id]/route")) as unknown as Handlers;
  session = await import("@/lib/auth/session");
  tokens = await import("@/lib/participant-token");
  publisher = await import("@/lib/realtime/publisher");
});

const req = (method: string, cookie: string | null, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (params: Record<string, string>): Ctx => ({ params: Promise.resolve(params) });

const addQa = async (title: string, config: Record<string, unknown> = {}, state: "draft" | "live" | "paused" = "paused") =>
  (
    await db
      .insert(interactions)
      .values({
        eventId,
        type: "qa",
        title,
        state,
        position: (await db.select().from(interactions).where(eq(interactions.eventId, eventId))).length,
        config: { prompt: "Ask", moderation: "open", ...config },
      })
      .returning()
  )[0].id;

const addQuestion = async (interactionId: string, text: string, status: "pending" | "approved" = "approved") => {
  const [p] = await db.select().from(participants).where(eq(participants.eventId, eventId));
  return (
    await db.insert(questions).values({ eventId, interactionId, participantId: p.id, text, status }).returning()
  )[0].id;
};

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  published = [];
  publisher.setPublisher({
    publish: (_e, name, payload, o) => void published.push({ name, payload, hostOnly: o?.hostOnly }),
  });
  const [user] = await db.insert(users).values({ email: "h@example.com", passwordHash: "x" }).returning();
  hostCookie = `${session.SESSION_COOKIE}=${session.createSessionToken(user.id)}`;
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
  first = await addQa("First");
  second = await addQa("Second");
  const [p] = await db.insert(participants).values({ eventId }).returning();
  guest = `${tokens.participantCookieName(eventId)}=${tokens.createParticipantToken(eventId, p.id)}`;
});

afterAll(async () => {
  await pool.end();
});

const approvedIn = async (interactionId: string) => {
  const res = await listRoute.GET(req("GET", guest), ctx({ id: interactionId }));
  return ((await res.json()) as { questions: { text: string }[] }).questions.map((q) => q.text);
};

test("a question is filed under the interaction it was sent to, and listed only there", async () => {
  const res = await listRoute.POST(req("POST", guest, { text: "Why second?" }), ctx({ id: second }));
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ status: "approved", interactionId: second });
  expect(await approvedIn(second)).toEqual(["Why second?"]);
  expect(await approvedIn(first)).toEqual([]);
  expect(published).toMatchObject([{ name: "question:added", payload: { interactionId: second } }]);
});

test("a non-Q&A or unknown interaction id answers 404", async () => {
  const [poll] = await db
    .insert(interactions)
    .values({ eventId, type: "rating", title: "R", position: 9, config: { prompt: "R", scale: "stars5" } })
    .returning();
  for (const id of [poll.id, "00000000-0000-4000-8000-000000000000", "nope"]) {
    expect((await listRoute.POST(req("POST", guest, { text: "x" }), ctx({ id }))).status).toBe(404);
    expect((await listRoute.GET(req("GET", guest), ctx({ id }))).status).toBe(404);
  }
});

test("moderation comes from the interaction config, not the event", async () => {
  const moderated = await addQa("Moderated", { moderation: "moderated" });
  await db.update(events).set({ moderationMode: "moderated" }).where(eq(events.id, eventId));

  const open = await listRoute.POST(req("POST", guest, { text: "open one" }), ctx({ id: first }));
  expect(await open.json()).toMatchObject({ status: "approved" });
  const held = await listRoute.POST(req("POST", guest, { text: "held one" }), ctx({ id: moderated }));
  expect(await held.json()).toMatchObject({ status: "pending" });
  expect(published.map((p) => p.name)).toEqual(["question:added", "question:pending"]);
  expect(published[1]).toMatchObject({ hostOnly: true, payload: { interactionId: moderated } });
});

test("the profanity filter follows the config and is on when the config does not say", async () => {
  const lax = await addQa("Lax", { profanityFilter: false });
  const strict = await addQa("Strict", { profanityFilter: true });
  const word = "this is shit";
  expect((await listRoute.POST(req("POST", guest, { text: word }), ctx({ id: first }))).status).toBe(400);
  expect((await listRoute.POST(req("POST", guest, { text: word }), ctx({ id: strict }))).status).toBe(400);
  expect((await listRoute.POST(req("POST", guest, { text: word }), ctx({ id: lax }))).status).toBe(201);
});

test("the host sees the queue of one interaction; participants cannot", async () => {
  await addQuestion(first, "a pending", "pending");
  await addQuestion(second, "b approved");
  const res = await queueRoute.GET(req("GET", hostCookie), ctx({ id: first }));
  expect(await res.json()).toMatchObject({ interactionId: first, questions: [{ text: "a pending", status: "pending" }] });
  expect((await queueRoute.GET(req("GET", guest), ctx({ id: first }))).status).toBe(401);
});

test("moderating and deleting address the interaction and publish its id", async () => {
  const pending = await addQuestion(first, "needs approval", "pending");
  const patch = await itemRoute.PATCH(req("PATCH", hostCookie, { status: "approved" }), ctx({ id: first, questionId: pending }));
  expect(patch.status).toBe(200);
  expect(published).toMatchObject([{ name: "question:added", payload: { interactionId: first } }]);

  published = [];
  await itemRoute.PATCH(req("PATCH", hostCookie, { pinned: true }), ctx({ id: first, questionId: pending }));
  expect(published).toMatchObject([{ name: "question:updated", payload: { interactionId: first, pinned: true } }]);

  published = [];
  const gone = await itemRoute.DELETE(req("DELETE", hostCookie), ctx({ id: first, questionId: pending }));
  expect(gone.status).toBe(204);
  expect(published).toMatchObject([{ name: "question:removed", payload: { interactionId: first, questionId: pending } }]);
});

test("a question cannot be reached through another interaction", async () => {
  const q = await addQuestion(first, "in first");
  const wrong = ctx({ id: second, questionId: q });
  expect((await itemRoute.PATCH(req("PATCH", hostCookie, { pinned: true }), wrong)).status).toBe(404);
  expect((await itemRoute.DELETE(req("DELETE", hostCookie), wrong)).status).toBe(404);
  expect((await upvoteRoute.POST(req("POST", guest), wrong)).status).toBe(404);
  expect(await db.select().from(questions).where(eq(questions.id, q))).toHaveLength(1);
});

test("upvoting through the interaction path counts and publishes the interaction id", async () => {
  const q = await addQuestion(second, "vote me");
  const res = await upvoteRoute.POST(req("POST", guest), ctx({ id: second, questionId: q }));
  expect(await res.json()).toMatchObject({ upvoted: true, upvotes: 1 });
  expect(published).toMatchObject([{ name: "question:votes", payload: { interactionId: second, questionId: q, upvotes: 1 } }]);
});

test("the event-level paths still resolve: the first Q&A, or the live one when there is one", async () => {
  // Nothing live: the first Q&A by position.
  const sent = await oldListRoute.POST(req("POST", guest, { text: "old path" }), ctx({ id: eventId }));
  expect(sent.status).toBe(201);
  expect(await sent.json()).toMatchObject({ interactionId: first });
  expect(await approvedIn(first)).toEqual(["old path"]);

  // A live Q&A takes over.
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, second));
  await oldListRoute.POST(req("POST", guest, { text: "to live" }), ctx({ id: eventId }));
  expect(await approvedIn(second)).toEqual(["to live"]);
  const listed = await oldListRoute.GET(req("GET", guest), ctx({ id: eventId }));
  expect(await listed.json()).toMatchObject({ interactionId: second, questions: [{ text: "to live" }] });

  const present = await oldPresentRoute.GET(req("GET", hostCookie), ctx({ id: eventId }));
  expect(await present.json()).toMatchObject({ interactionId: second, questions: [{ text: "to live" }] });

  await addQuestion(second, "held", "pending");
  const queue = await oldModerationRoute.GET(req("GET", hostCookie), ctx({ id: eventId }));
  expect(await queue.json()).toMatchObject({ interactionId: second, questions: expect.arrayContaining([expect.objectContaining({ text: "held" })]) });
});

test("event-level moderation and upvote paths act on a question wherever it sits", async () => {
  const q = await addQuestion(first, "elsewhere", "pending");
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, second));
  const ok = await oldItemRoute.PATCH(req("PATCH", hostCookie, { status: "approved" }), ctx({ id: eventId, questionId: q }));
  expect(ok.status).toBe(200);
  expect(published).toMatchObject([{ name: "question:added", payload: { interactionId: first } }]);
  const vote = await oldUpvoteRoute.POST(req("POST", guest), ctx({ id: q }));
  expect(await vote.json()).toMatchObject({ upvotes: 1 });
  const missing = await oldItemRoute.DELETE(req("DELETE", hostCookie), ctx({ id: eventId, questionId: "00000000-0000-4000-8000-000000000000" }));
  expect(missing.status).toBe(404);
});

test("the event-level path creates a Q&A for an event without one, but only for a participant", async () => {
  await db.delete(interactions).where(eq(interactions.eventId, eventId));
  expect((await oldListRoute.POST(req("POST", null, { text: "anon" }), ctx({ id: eventId }))).status).toBe(401);
  expect(await db.select().from(interactions).where(eq(interactions.eventId, eventId))).toHaveLength(0);
  expect((await oldListRoute.POST(req("POST", guest, { text: "joined" }), ctx({ id: eventId }))).status).toBe(201);
  expect(await db.select().from(interactions).where(eq(interactions.eventId, eventId))).toHaveLength(1);

  await db.delete(interactions).where(eq(interactions.eventId, eventId));
  const empty = await oldListRoute.GET(req("GET", guest), ctx({ id: eventId }));
  expect(await empty.json()).toEqual({ interactionId: null, questions: [] });
});

test("the event moderation mode no longer changes the event's Q&As", async () => {
  const res = await eventRoute.PATCH(req("PATCH", hostCookie, { moderationMode: "moderated" }), ctx({ id: eventId }));
  expect(res.status).toBe(200);
  const rows = await db.select().from(interactions).where(eq(interactions.eventId, eventId));
  expect(rows.map((r) => (r.config as { moderation: string }).moderation)).toEqual(["open", "open"]);
});

test("the event-level moderation route lists the queue of the Q&A named by ?interaction=", async () => {
  await addQuestion(first, "On the first", "pending");
  await addQuestion(second, "On the second", "pending");
  const ask = async (qs: string, id = eventId) => {
    const request = new Request(`http://localhost/api${qs}`, { headers: { cookie: hostCookie } });
    return oldModerationRoute.GET(request, ctx({ id }));
  };
  const named = await (await ask(`?interaction=${second}`)).json();
  expect(named.interactionId).toBe(second);
  expect(named.questions.map((q: { text: string }) => q.text)).toEqual(["On the second"]);
  const fallback = await (await ask("")).json();
  expect(fallback.interactionId).toBe(first);
  expect((await ask("?interaction=not-an-id")).status).toBe(404);
  expect((await ask(`?interaction=${first}`, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
});

test("a draft Q&A comes after started ones when the event-level paths pick one", async () => {
  await db.update(interactions).set({ state: "draft" }).where(eq(interactions.id, first));
  const res = await oldPresentRoute.GET(req("GET", hostCookie), ctx({ id: eventId }));
  expect((await res.json()).interactionId).toBe(second);
});
