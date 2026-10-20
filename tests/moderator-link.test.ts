// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, participants, questions, users } from "@/db/schema";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
type QCtx = { params: Promise<{ id: string; questionId: string }> };
let linkRoute: typeof import("@/app/api/events/[id]/moderator-link/route");
let queueRoute: typeof import("@/app/api/events/[id]/moderation/route");
let questionRoute: typeof import("@/app/api/events/[id]/questions/[questionId]/route");
let eventRoute: typeof import("@/app/api/events/[id]/route");
let eventsRoute: typeof import("@/app/api/events/route");
let session: typeof import("@/lib/auth/session");
let tokenLib: typeof import("@/lib/moderator-token");
let hostCookie: string;
let eventId: string;
let otherEventId: string;
let questionId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  linkRoute = await import("@/app/api/events/[id]/moderator-link/route");
  queueRoute = await import("@/app/api/events/[id]/moderation/route");
  questionRoute = await import("@/app/api/events/[id]/questions/[questionId]/route");
  eventRoute = await import("@/app/api/events/[id]/route");
  eventsRoute = await import("@/app/api/events/route");
  session = await import("@/lib/auth/session");
  tokenLib = await import("@/lib/moderator-token");
});

beforeEach(async () => {
  await truncateAll(db);
  const [user] = await db.insert(users).values({ email: "h@example.com", passwordHash: "x" }).returning();
  hostCookie = `${session.SESSION_COOKIE}=${session.createSessionToken(user.id)}`;
  const make = async (joinCode: string) =>
    (
      await db
        .insert(events)
        .values({
          workspaceId: await workspaceFor(db, user.id), ownerId: user.id,
          name: joinCode,
          startsAt: new Date("2026-11-01T10:00:00Z"),
          endsAt: new Date("2026-11-01T11:00:00Z"),
          joinCode,
        })
        .returning()
    )[0].id;
  eventId = await make("111111");
  otherEventId = await make("222222");
  const [p] = await db.insert(participants).values({ eventId }).returning();
  const [q] = await db.insert(questions).values({ eventId, participantId: p.id, text: "Why?", status: "pending" }).returning();
  questionId = q.id;
});

afterAll(() => pool.end());

const ctx = (id = eventId): Ctx => ({ params: Promise.resolve({ id }) });
const qctx = (id = eventId): QCtx => ({ params: Promise.resolve({ id, questionId }) });
const req = (method: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const asMod = (token: string) => ({ "x-moderator-token": token });

const generate = async () => {
  const res = await linkRoute.POST(req("POST", { cookie: hostCookie }), ctx());
  const { link } = (await res.json()) as { link: string };
  return new URL(link, "http://localhost").searchParams.get("t")!;
};

test("host generates a link; the token opens the queue and can moderate", async () => {
  const token = await generate();
  const queue = await queueRoute.GET(req("GET", asMod(token)), ctx());
  expect(queue.status).toBe(200);
  expect(((await queue.json()) as { questions: unknown[] }).questions).toHaveLength(1);

  for (const body of [{ status: "approved" }, { pinned: true }, { answered: true }]) {
    expect((await questionRoute.PATCH(req("PATCH", asMod(token), body), qctx())).status).toBe(200);
  }
  expect((await questionRoute.DELETE(req("DELETE", asMod(token)), qctx())).status).toBe(204);
});

test("GET returns the current link and null after revoking", async () => {
  expect(await (await linkRoute.GET(req("GET", { cookie: hostCookie }), ctx())).json()).toEqual({ link: null });
  const token = await generate();
  const { link } = (await (await linkRoute.GET(req("GET", { cookie: hostCookie }), ctx())).json()) as { link: string };
  expect(link).toContain(encodeURIComponent(token));
});

test("revoking stops the link immediately", async () => {
  const token = await generate();
  expect((await linkRoute.DELETE(req("DELETE", { cookie: hostCookie }), ctx())).status).toBe(204);
  expect((await queueRoute.GET(req("GET", asMod(token)), ctx())).status).toBe(401);
  expect((await questionRoute.PATCH(req("PATCH", asMod(token), { status: "approved" }), qctx())).status).toBe(401);
  expect(await tokenLib.verifyModeratorToken(eventId, token)).toBe(false);
});

test("regenerating invalidates the old link", async () => {
  const oldToken = await generate();
  const newToken = await generate();
  expect(oldToken).not.toBe(newToken);
  expect((await queueRoute.GET(req("GET", asMod(oldToken)), ctx())).status).toBe(401);
  expect((await queueRoute.GET(req("GET", asMod(newToken)), ctx())).status).toBe(200);
});

test("a token for one event does not work for another, and forged tokens fail", async () => {
  const token = await generate();
  expect((await queueRoute.GET(req("GET", asMod(token)), ctx(otherEventId))).status).toBe(401);
  const [nonce] = token.split(".");
  expect((await queueRoute.GET(req("GET", asMod(`${nonce}.forged`)), ctx())).status).toBe(401);
  expect((await queueRoute.GET(req("GET", asMod("garbage")), ctx())).status).toBe(401);
  // Event B has a link of its own with a different nonce; its signature must not validate for event A.
  await linkRoute.POST(req("POST", { cookie: hostCookie }), ctx(otherEventId));
  const otherToken = tokenLib.createModeratorToken(otherEventId, nonce);
  expect((await queueRoute.GET(req("GET", asMod(otherToken)), ctx(otherEventId))).status).toBe(401);
});

test("the token grants nothing outside the moderation queue", async () => {
  const token = await generate();
  const headers = asMod(token);
  expect((await linkRoute.GET(req("GET", headers), ctx())).status).toBe(401);
  expect((await linkRoute.POST(req("POST", headers), ctx())).status).toBe(401);
  expect((await linkRoute.DELETE(req("DELETE", headers), ctx())).status).toBe(401);
  expect((await eventRoute.GET(req("GET", headers), ctx())).status).toBe(401);
  expect((await eventRoute.PATCH(req("PATCH", headers, { moderationMode: "open" }), ctx())).status).toBe(401);
  expect((await eventsRoute.GET(req("GET", headers))).status).toBe(401);
});

test("without a token or session the queue is unauthorized; other owners get 404", async () => {
  expect((await queueRoute.GET(req("GET"), ctx())).status).toBe(401);
  const host = await queueRoute.GET(req("GET", { cookie: hostCookie }), ctx());
  expect(host.status).toBe(200);
  const [stranger] = await db.insert(users).values({ email: "s@example.com", passwordHash: "x" }).returning();
  const strangerCookie = `${session.SESSION_COOKIE}=${session.createSessionToken(stranger.id)}`;
  expect((await queueRoute.GET(req("GET", { cookie: strangerCookie }), ctx())).status).toBe(404);
  expect((await linkRoute.POST(req("POST", { cookie: strangerCookie }), ctx())).status).toBe(404);
});
