// @vitest-environment node
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, participants, users } from "@/db/schema";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { createParticipantToken, participantCookieName } from "@/lib/participant-token";
import { publish, setPublisher } from "@/lib/realtime/publisher";
import { attachSocketServer } from "@/lib/realtime/socket-server";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

let httpServer: HttpServer;
let url: string;
let ownerId: string;
let eventA: string;
let eventB: string;
let clients: Socket[] = [];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  process.env.SESSION_SECRET ||= "test-session-secret";
  httpServer = createServer();
  attachSocketServer(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateAll(db);
  const [user] = await db.insert(users).values({ email: "h@example.com", passwordHash: "x" }).returning();
  ownerId = user.id;
  const make = async (joinCode: string) => {
    const [e] = await db
      .insert(events)
      .values({
        workspaceId: await workspaceFor(db, ownerId),
        ownerId,
        name: joinCode,
        startsAt: new Date("2026-11-01T10:00:00Z"),
        endsAt: new Date("2026-11-01T11:00:00Z"),
        joinCode,
      })
      .returning();
    return e.id;
  };
  eventA = await make("111111");
  eventB = await make("222222");
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

async function participantCookie(eventId: string) {
  const [p] = await db.insert(participants).values({ eventId }).returning();
  return `${participantCookieName(eventId)}=${createParticipantToken(eventId, p.id)}`;
}

function open(auth: object, cookie?: string) {
  const socket = connect(url, {
    auth,
    transports: ["websocket"],
    reconnection: false,
    extraHeaders: cookie ? { cookie } : {},
  });
  clients.push(socket);
  return new Promise<Socket>((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

const nextMessage = (socket: Socket, name: string) =>
  new Promise((resolve) => socket.once(name, resolve));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("clients in one event receive a published message; another event does not", async () => {
  const a1 = await open({ eventId: eventA, role: "participant" }, await participantCookie(eventA));
  const a2 = await open({ eventId: eventA, role: "participant" }, await participantCookie(eventA));
  const b1 = await open({ eventId: eventB, role: "participant" }, await participantCookie(eventB));
  let leaked = false;
  b1.on("ping-test", () => (leaked = true));

  const got = Promise.all([nextMessage(a1, "ping-test"), nextMessage(a2, "ping-test")]);
  publish(eventA, "ping-test", { n: 1 });
  expect(await got).toEqual([{ n: 1 }, { n: 1 }]);
  await sleep(100);
  expect(leaked).toBe(false);
});

test("host-only messages reach the host but not participants", async () => {
  const host = await open(
    { eventId: eventA, role: "host" },
    `${SESSION_COOKIE}=${createSessionToken(ownerId)}`,
  );
  const part = await open({ eventId: eventA, role: "participant" }, await participantCookie(eventA));
  let leaked = false;
  part.on("secret", () => (leaked = true));

  const got = nextMessage(host, "secret");
  publish(eventA, "secret", { q: 1 }, { hostOnly: true });
  expect(await got).toEqual({ q: 1 });
  await sleep(100);
  expect(leaked).toBe(false);
});

test("unauthorized sockets are rejected", async () => {
  const hostCookie = `${SESSION_COOKIE}=${createSessionToken(ownerId)}`;
  const [other] = await db.insert(users).values({ email: "o@example.com", passwordHash: "x" }).returning();

  await expect(open({ eventId: eventA, role: "host" })).rejects.toThrow("unauthorized");
  await expect(
    open({ eventId: eventA, role: "host" }, `${SESSION_COOKIE}=${createSessionToken(other.id)}`),
  ).rejects.toThrow("unauthorized");
  // A participant cookie must not grant the host role.
  await expect(
    open({ eventId: eventA, role: "host" }, await participantCookie(eventA)),
  ).rejects.toThrow("unauthorized");
  // A participant token for event A is not valid for event B.
  await expect(
    open({ eventId: eventB, role: "participant" }, await participantCookie(eventA)),
  ).rejects.toThrow("unauthorized");
  await expect(open({ eventId: "nope", role: "participant" })).rejects.toThrow("unauthorized");
  // The owner's host session works.
  await expect(open({ eventId: eventA, role: "host" }, hostCookie)).resolves.toBeDefined();
});

test("moderator token joins the host room for its event only, and not once revoked", async () => {
  const { regenerateModeratorToken, revokeModeratorToken } = await import("@/lib/moderator-token");
  const token = await regenerateModeratorToken(eventA);
  const mod = await open({ eventId: eventA, role: "moderator", token });
  const got = nextMessage(mod, "secret");
  publish(eventA, "secret", { q: 2 }, { hostOnly: true });
  expect(await got).toEqual({ q: 2 });

  await expect(open({ eventId: eventB, role: "moderator", token })).rejects.toThrow("unauthorized");
  await expect(open({ eventId: eventA, role: "moderator" })).rejects.toThrow("unauthorized");
  await revokeModeratorToken(eventA);
  await expect(open({ eventId: eventA, role: "moderator", token })).rejects.toThrow("unauthorized");
});

const presenceOf = (host: Socket) => nextMessage(host, "presence") as Promise<{ count: number }>;

async function hostFor(eventId: string) {
  const host = await open({ eventId, role: "host" }, `${SESSION_COOKIE}=${createSessionToken(ownerId)}`);
  return host;
}

test("presence counts connected participants, decrements on disconnect and tracks the peak", async () => {
  const host = await hostFor(eventA);
  const counts: number[] = [];
  host.on("presence", (p: { count: number }) => counts.push(p.count));

  const p1 = await open({ eventId: eventA, role: "participant" }, await participantCookie(eventA));
  const p2 = await open({ eventId: eventA, role: "participant" }, await participantCookie(eventA));
  await sleep(200);
  expect(counts.at(-1)).toBe(2);

  p1.disconnect();
  await sleep(200);
  expect(counts.at(-1)).toBe(1);

  const p3 = await open({ eventId: eventA, role: "participant" }, await participantCookie(eventA));
  await sleep(200);
  expect(counts.at(-1)).toBe(2);
  p2.disconnect();
  p3.disconnect();
  await sleep(200);
  expect(counts.at(-1)).toBe(0);

  const [row] = await db.select({ peak: events.peakParticipants }).from(events).where(eq(events.id, eventA));
  expect(row.peak).toBe(2);
  const [other] = await db.select({ peak: events.peakParticipants }).from(events).where(eq(events.id, eventB));
  expect(other.peak).toBe(0);
});

test("a late-connecting host gets the current count, and one participant in two tabs counts once", async () => {
  const cookie = await participantCookie(eventA);
  await open({ eventId: eventA, role: "participant" }, cookie);
  await open({ eventId: eventA, role: "participant" }, cookie);
  await sleep(200);
  const host = connect(url, {
    auth: { eventId: eventA, role: "host" },
    transports: ["websocket"],
    reconnection: false,
    extraHeaders: { cookie: `${SESSION_COOKIE}=${createSessionToken(ownerId)}` },
  });
  clients.push(host);
  expect(await presenceOf(host)).toEqual({ count: 1 });
});
