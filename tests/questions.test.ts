// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, participants, questionVotes, questions } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
let upvoteRoute: { POST: (r: Request, c: Ctx) => Promise<Response> };
let route: { POST: (r: Request, c: Ctx) => Promise<Response>; GET: (r: Request, c: Ctx) => Promise<Response> };
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let eventRoute: { PATCH: (r: Request, c: Ctx) => Promise<Response> };
let signup: (req: Request) => Promise<Response>;
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;
let hostCookie: string;
let eventId: string;
let cookie: string;
let published: { name: string; payload: unknown; hostOnly?: boolean }[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  route = await import("@/app/api/events/[id]/questions/route");
  upvoteRoute = await import("@/app/api/questions/[id]/upvote/route");
  eventsRoute = await import("@/app/api/events/route");
  eventRoute = await import("@/app/api/events/[id]/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
  tokens = await import("@/lib/participant-token");
  publisher = await import("@/lib/realtime/publisher");
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

const req = (method: string, body?: unknown, c: string | null = cookie) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id = eventId): Ctx => ({ params: Promise.resolve({ id }) });

const join = async () => {
  const [p] = await db.insert(participants).values({ eventId }).returning();
  return `${tokens.participantCookieName(eventId)}=${tokens.createParticipantToken(eventId, p.id)}`;
};
const ask = (body: unknown, c: string | null = cookie) => route.POST(req("POST", body, c), ctx());
const list = async (c: string | null = cookie) => {
  const res = await route.GET(req("GET", undefined, c), ctx());
  return { res, json: await res.json() };
};
const setMode = (moderationMode: "open" | "moderated") =>
  db.update(events).set({ moderationMode }).where(eq(events.id, eventId));

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  published = [];
  publisher.setPublisher({
    publish: (_id, name, payload, opts) => void published.push({ name, payload, hostOnly: opts?.hostOnly }),
  });
  const res = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "host@example.com", password: "password123" }),
    }),
  );
  hostCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const created = await eventsRoute.POST(
    req("POST", { name: "Town hall", startsAt: "2026-11-01T10:00:00Z", endsAt: "2026-11-01T12:00:00Z" }, hostCookie),
  );
  eventId = (await created.json()).event.id;
  cookie = await join();
});

afterAll(async () => {
  await pool.end();
});

test("open mode approves new questions and lists them anonymously by default", async () => {
  const res = await ask({ text: "  When do we ship?  " });
  expect(res.status).toBe(201);
  expect((await res.json()).status).toBe("approved");

  const { json } = await list();
  expect(json.questions).toHaveLength(1);
  expect(json.questions[0]).toMatchObject({ text: "When do we ship?", authorName: null, answered: false, pinned: false });
  expect(json.questions[0]).not.toHaveProperty("participantId");
  expect(published.map((p) => p.name)).toEqual(["question:added"]);
  expect(published[0].hostOnly).toBeUndefined();
});

test("a name is stored only when provided", async () => {
  await ask({ text: "Named?", authorName: " Ada " });
  await ask({ text: "Blank name", authorName: "   " });
  const { json } = await list();
  const byText = Object.fromEntries(json.questions.map((q: { text: string; authorName: string | null }) => [q.text, q.authorName]));
  expect(byText).toEqual({ "Named?": "Ada", "Blank name": null });
});

test("moderated mode stores pending questions and never exposes them", async () => {
  await setMode("moderated");
  const res = await ask({ text: "Hidden until approved" });
  expect(res.status).toBe(201);
  expect((await res.json()).status).toBe("pending");

  expect((await list()).json.questions).toEqual([]);
  expect((await list(hostCookie)).json.questions).toEqual([]);
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({ name: "question:pending", hostOnly: true });
});

test("rejected questions are never listed", async () => {
  await ask({ text: "Keep" });
  await ask({ text: "Drop" });
  await db.update(questions).set({ status: "rejected" }).where(eq(questions.text, "Drop"));
  expect((await list()).json.questions.map((q: { text: string }) => q.text)).toEqual(["Keep"]);
});

test("changing the mode to moderated applies to later questions only", async () => {
  await ask({ text: "Before" });
  await eventRoute.PATCH(req("PATCH", { moderationMode: "moderated" }, hostCookie), ctx());
  await ask({ text: "After" });
  expect((await list()).json.questions.map((q: { text: string }) => q.text)).toEqual(["Before"]);
});

test("pinned questions come first", async () => {
  await ask({ text: "one" });
  await ask({ text: "two" });
  await db.update(questions).set({ pinned: true }).where(eq(questions.text, "one"));
  expect((await list()).json.questions.map((q: { text: string }) => q.text)).toEqual(["one", "two"]);
});

test("rate limits to 5 questions per participant per minute", async () => {
  for (let i = 0; i < 5; i++) expect((await ask({ text: `q${i}` })).status).toBe(201);
  const limited = await ask({ text: "q5" });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBeTruthy();

  const other = await join();
  expect((await ask({ text: "other" }, other)).status).toBe(201);
});

test("validates text, name and profanity", async () => {
  expect((await ask({ text: "   " })).status).toBe(400);
  expect((await ask({})).status).toBe(400);
  expect((await ask({ text: "x".repeat(301) })).status).toBe(400);
  expect((await ask({ text: "x".repeat(300) })).status).toBe(201);
  await getRateLimitStore().reset();
  expect((await ask({ text: "ok", authorName: "n".repeat(41) })).status).toBe(400);
  expect((await ask({ text: "this is shit" })).status).toBe(400);
  expect((await ask({ text: "fine", authorName: "asshole" })).status).toBe(400);
  expect(await db.select().from(questions)).toHaveLength(1);
});

test("requires a participant to ask and a participant or owner to list", async () => {
  expect((await ask({ text: "hi" }, null)).status).toBe(401);
  expect((await ask({ text: "hi" }, hostCookie)).status).toBe(401);
  expect((await list(null)).res.status).toBe(401);
  expect((await list(hostCookie)).res.status).toBe(200);

  const other = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other@example.com", password: "password123" }),
    }),
  );
  const otherCookie = (other.headers.get("set-cookie") ?? "").split(";")[0];
  expect((await list(otherCookie)).res.status).toBe(404);
});

test("unknown or malformed event ids give 404", async () => {
  const bad = await route.POST(req("POST", { text: "x" }), ctx("not-a-uuid"));
  expect(bad.status).toBe(404);
  const missing = await route.GET(req("GET"), ctx("00000000-0000-4000-8000-000000000000"));
  expect(missing.status).toBe(401);
});

const upvote = (id: string, c: string | null = cookie) => upvoteRoute.POST(req("POST", undefined, c), ctx(id));
const askId = async (body: unknown = { text: "Why?" }) => (await (await ask(body)).json()).question.id as string;

test("upvote toggles on and off, counts are listed and published", async () => {
  const id = await askId();
  const on = await upvote(id);
  expect(on.status).toBe(200);
  expect(await on.json()).toEqual({ ok: true, upvoted: true, upvotes: 1 });
  expect(published.at(-1)).toMatchObject({ name: "question:votes", payload: { questionId: id, upvotes: 1 } });

  const other = await join();
  expect((await (await upvote(id, other)).json()).upvotes).toBe(2);

  const mine = (await list(cookie)).json.questions[0];
  expect(mine).toMatchObject({ upvotes: 2, upvoted: true });
  expect((await list(hostCookie)).json.questions[0]).toMatchObject({ upvotes: 2, upvoted: false });

  const off = await upvote(id);
  expect(await off.json()).toEqual({ ok: true, upvoted: false, upvotes: 1 });
  expect((await list(cookie)).json.questions[0]).toMatchObject({ upvotes: 1, upvoted: false });
});

test("a participant has at most one upvote per question", async () => {
  const id = await askId();
  await Promise.all([upvote(id), upvote(id), upvote(id)]);
  expect((await db.select().from(questionVotes)).length).toBeLessThanOrEqual(1);
  await expect(
    db.insert(questionVotes).values([
      { questionId: id, participantId: (await db.select().from(participants))[0].id },
      { questionId: id, participantId: (await db.select().from(participants))[0].id },
    ]),
  ).rejects.toThrow();
});

test("pending and rejected questions cannot be upvoted", async () => {
  await setMode("moderated");
  const pending = await askId();
  expect((await upvote(pending)).status).toBe(404);
  const id = await askId({ text: "second" });
  await db.update(questions).set({ status: "rejected" }).where(eq(questions.id, id));
  expect((await upvote(id)).status).toBe(404);
  expect(await db.select().from(questionVotes)).toHaveLength(0);
});

test("upvoting needs a participant of the question's event, and a real question", async () => {
  const id = await askId();
  expect((await upvote(id, null)).status).toBe(401);
  expect((await upvote(id, hostCookie)).status).toBe(401);
  expect((await upvote("not-a-uuid")).status).toBe(404);
  expect((await upvote("00000000-0000-4000-8000-000000000000")).status).toBe(404);
});

test("upvotes are rate limited per participant", async () => {
  const id = await askId();
  for (let i = 0; i < 30; i++) expect((await upvote(id)).status).toBe(200);
  const limited = await upvote(id);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBeTruthy();
});

// Moderation
type QCtx = { params: Promise<{ id: string; questionId: string }> };
const qctx = (questionId: string): QCtx => ({ params: Promise.resolve({ id: eventId, questionId }) });

async function moderationSetup() {
  await setMode("moderated");
  const res = await ask({ text: "Pending one" });
  return (await res.json()).question.id as string;
}

test("host approves a pending question: participants get it live, and it then lists", async () => {
  const modRoute = await import("@/app/api/events/[id]/questions/[questionId]/route");
  const id = await moderationSetup();
  expect((await list()).json.questions).toEqual([]);
  published = [];
  const res = await modRoute.PATCH(req("PATCH", { status: "approved" }, hostCookie), qctx(id));
  expect(res.status).toBe(200);
  expect(published).toMatchObject([{ name: "question:added", hostOnly: undefined }]);
  expect((await list()).json.questions.map((q: { id: string }) => q.id)).toEqual([id]);
});

test("rejected questions never reach participants", async () => {
  const modRoute = await import("@/app/api/events/[id]/questions/[questionId]/route");
  const id = await moderationSetup();
  published = [];
  const res = await modRoute.PATCH(req("PATCH", { status: "rejected" }, hostCookie), qctx(id));
  expect(res.status).toBe(200);
  expect(published).toEqual([]);
  expect((await list()).json.questions).toEqual([]);
  const again = await modRoute.PATCH(req("PATCH", { status: "approved" }, hostCookie), qctx(id));
  expect(again.status).toBe(404);
  expect((await list()).json.questions).toEqual([]);
});

test("host can pin, mark answered and delete approved questions; pinned list first", async () => {
  const modRoute = await import("@/app/api/events/[id]/questions/[questionId]/route");
  const first = (await (await ask({ text: "first" })).json()).question.id as string;
  const second = (await (await ask({ text: "second" })).json()).question.id as string;
  published = [];
  expect((await modRoute.PATCH(req("PATCH", { pinned: true }, hostCookie), qctx(first))).status).toBe(200);
  expect((await modRoute.PATCH(req("PATCH", { answered: true }, hostCookie), qctx(first))).status).toBe(200);
  expect(published.map((p) => p.name)).toEqual(["question:updated", "question:updated"]);
  const listed = (await list()).json.questions;
  expect(listed.map((q: { id: string }) => q.id)).toEqual([first, second]);
  expect(listed[0]).toMatchObject({ pinned: true, answered: true });

  published = [];
  expect((await modRoute.DELETE(req("DELETE", undefined, hostCookie), qctx(first))).status).toBe(204);
  expect(published).toMatchObject([{ name: "question:removed", payload: { questionId: first } }]);
  expect((await list()).json.questions.map((q: { id: string }) => q.id)).toEqual([second]);
});

test("pinning a pending question is refused", async () => {
  const modRoute = await import("@/app/api/events/[id]/questions/[questionId]/route");
  const id = await moderationSetup();
  expect((await modRoute.PATCH(req("PATCH", { pinned: true }, hostCookie), qctx(id))).status).toBe(409);
});

test("moderation endpoints are host-only and owner-only", async () => {
  const modRoute = await import("@/app/api/events/[id]/questions/[questionId]/route");
  const queue = await import("@/app/api/events/[id]/moderation/route");
  const id = await moderationSetup();
  // Participant and anonymous callers
  expect((await modRoute.PATCH(req("PATCH", { status: "approved" }), qctx(id))).status).toBe(401);
  expect((await modRoute.DELETE(req("DELETE", undefined, null), qctx(id))).status).toBe(401);
  expect((await queue.GET(req("GET"), ctx())).status).toBe(401);
  // Another admin
  const other = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other@example.com", password: "password123" }),
    }),
  );
  const otherCookie = (other.headers.get("set-cookie") ?? "").split(";")[0];
  expect((await modRoute.PATCH(req("PATCH", { status: "approved" }, otherCookie), qctx(id))).status).toBe(404);
  expect((await modRoute.DELETE(req("DELETE", undefined, otherCookie), qctx(id))).status).toBe(404);
  expect((await queue.GET(req("GET", undefined, otherCookie), ctx())).status).toBe(404);
  const [row] = await db.select().from(questions).where(eq(questions.id, id));
  expect(row.status).toBe("pending");
});

test("pending questions never leak to participants; the host queue lists them", async () => {
  const queue = await import("@/app/api/events/[id]/moderation/route");
  const id = await moderationSetup();
  expect(published).toMatchObject([{ name: "question:pending", hostOnly: true }]);
  expect(JSON.stringify((await list()).json)).not.toContain("Pending one");
  const res = await queue.GET(req("GET", undefined, hostCookie), ctx());
  expect((await res.json()).questions).toMatchObject([{ id, status: "pending", text: "Pending one" }]);
});
