// @vitest-environment node
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { participants, users } from "@/db/schema";
import { createParticipantToken, participantCookieName } from "@/lib/participant-token";
import { setPublisher } from "@/lib/realtime/publisher";
import { attachSocketServer } from "@/lib/realtime/socket-server";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request, ctx: { params: Promise<{ id: string; interactionId: string }> }) => Promise<Response>;
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: Handler };
let start: { POST: Handler };
let close: { POST: Handler };
let duplicate: { POST: Handler };
let signup: (req: Request) => Promise<Response>;
let cookie: string;
let eventId: string;
let httpServer: HttpServer;
let url: string;
let clients: Socket[] = [];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  start = await import("@/app/api/events/[id]/interactions/[interactionId]/start/route");
  close = await import("@/app/api/events/[id]/interactions/[interactionId]/close/route");
  duplicate = await import("@/app/api/events/[id]/interactions/[interactionId]/duplicate/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
  httpServer = createServer();
  attachSocketServer(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

const req = (body?: unknown, c: string | null = cookie) =>
  new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string, interactionId = "") => ({ params: Promise.resolve({ id, interactionId }) });

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

async function newEvent(c = cookie) {
  const res = await eventsRoute.POST(
    req({ name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }, c),
  );
  return (await res.json()).event.id as string;
}

async function newPoll(id = eventId) {
  const res = await collection.POST(req({ type: "poll", question: "Q?", options: ["A", "B"] }), ctx(id));
  return (await res.json()).interaction.id as string;
}

const run = (route: { POST: Handler }, id: string, interactionId: string, c: string | null = cookie) =>
  route.POST(req(undefined, c), ctx(id, interactionId));

beforeEach(async () => {
  await truncateAll(db);
  cookie = await newHost("host@example.com");
  eventId = await newEvent();
});

afterEach(() => {
  for (const c of clients) c.disconnect();
  clients = [];
});

afterAll(async () => {
  setPublisher(null);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await pool.end();
});

test("start sets live; close sets closed", async () => {
  const id = await newPoll();
  const started = await run(start, eventId, id);
  expect(started.status).toBe(200);
  expect((await started.json()).interaction.state).toBe("live");
  const closed = await run(close, eventId, id);
  expect(closed.status).toBe(200);
  expect((await closed.json()).interaction.state).toBe("closed");
});

test("first start records the host's first_interaction_live_at once", async () => {
  const read = async () =>
    (await db.select({ at: users.firstInteractionLiveAt }).from(users).where(eq(users.email, "host@example.com")))[0].at;
  expect(await read()).toBeNull();
  await run(start, eventId, await newPoll());
  const first = await read();
  expect(first).toBeInstanceOf(Date);
  await run(start, eventId, await newPoll());
  expect(await read()).toEqual(first);
});

test("only one interaction is live at a time", async () => {
  const a = await newPoll();
  const b = await newPoll();
  await run(start, eventId, a);
  expect((await run(start, eventId, b)).status).toBe(200);
  const states = await Promise.all(
    [a, b].map(async (i) => (await (await run(close, eventId, i)).json()).interaction?.state),
  );
  // a was closed by starting b, so only b can still be closed.
  expect(states).toEqual([undefined, "closed"]);
});

test("starting a different event's interaction does not close this event's live one", async () => {
  const other = await newEvent();
  const a = await newPoll();
  const b = await newPoll(other);
  await run(start, eventId, a);
  await run(start, other, b);
  expect((await run(close, eventId, a)).status).toBe(200);
});

test("concurrent starts leave exactly one live interaction", async () => {
  const ids = await Promise.all([newPoll(), newPoll(), newPoll()]);
  const results = await Promise.all(ids.map((i) => run(start, eventId, i)));
  expect(results.every((r) => r.status === 200)).toBe(true);
  const closes = await Promise.all(ids.map((i) => run(close, eventId, i)));
  expect(closes.filter((r) => r.status === 200)).toHaveLength(1);
});

test("a closed or live interaction cannot be started; a duplicate can", async () => {
  const id = await newPoll();
  await run(start, eventId, id);
  expect((await run(start, eventId, id)).status).toBe(409);
  await run(close, eventId, id);
  expect((await run(start, eventId, id)).status).toBe(409);
  const copy = (await (await run(duplicate, eventId, id)).json()).interaction.id;
  expect((await run(start, eventId, copy)).status).toBe(200);
});

test("closing a draft is rejected", async () => {
  const id = await newPoll();
  expect((await run(close, eventId, id)).status).toBe(409);
});

test("requires the owner and a known interaction", async () => {
  const id = await newPoll();
  expect((await run(start, eventId, id, null)).status).toBe(401);
  const other = await newHost("other@example.com");
  expect((await run(start, eventId, id, other)).status).toBe(404);
  expect((await run(start, eventId, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
});

test("participants in the room receive state-changed", async () => {
  const [p] = await db.insert(participants).values({ eventId }).returning();
  const socket = connect(url, {
    auth: { eventId, role: "participant" },
    transports: ["websocket"],
    reconnection: false,
    extraHeaders: { cookie: `${participantCookieName(eventId)}=${createParticipantToken(eventId, p.id)}` },
  });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", reject);
  });

  const a = await newPoll();
  const b = await newPoll();
  const received: unknown[] = [];
  socket.on("state-changed", (m) => received.push(m));

  const t0 = Date.now();
  await run(start, eventId, a);
  await expect.poll(() => received.length, { timeout: 1000 }).toBe(1);
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(received[0]).toEqual({ interactionId: a, state: "live" });

  await run(start, eventId, b);
  await expect.poll(() => received.length, { timeout: 1000 }).toBe(3);
  expect(received.slice(1)).toEqual([
    { interactionId: a, state: "closed" },
    { interactionId: b, state: "live" },
  ]);
});
