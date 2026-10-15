// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, participants, users } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

let live: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let createToken: typeof import("@/lib/participant-token").createParticipantToken;
let cookieName: typeof import("@/lib/participant-token").participantCookieName;
let eventId: string;
let cookie: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  live = (await import("@/app/api/events/[id]/live/route")).GET;
  const tokens = await import("@/lib/participant-token");
  createToken = tokens.createParticipantToken;
  cookieName = tokens.participantCookieName;
});

beforeEach(async () => {
  await truncateAll(db);
  const [user] = await db.insert(users).values({ email: "host@example.com", passwordHash: "x" }).returning();
  const [event] = await db
    .insert(events)
    .values({
      ownerId: user.id,
      name: "Town hall",
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T11:00:00Z"),
      joinCode: "123456",
    })
    .returning();
  eventId = event.id;
  const [p] = await db.insert(participants).values({ eventId }).returning();
  cookie = `${cookieName(eventId)}=${createToken(eventId, p.id)}`;
});
afterAll(() => pool.end());

const call = (id = eventId, c: string | null = cookie) =>
  live(new Request(`http://localhost/api/events/${id}/live`, { headers: c ? { cookie: c } : {} }), {
    params: Promise.resolve({ id }),
  });

const poll = (state: "draft" | "live" | "closed", position: number) =>
  db
    .insert(interactions)
    .values({
      eventId,
      type: "poll",
      title: "Lunch?",
      state,
      position,
      config: {
        options: [
          { id: "a", label: "Pizza" },
          { id: "b", label: "Tacos" },
        ],
        multiSelect: false,
        showResultsToParticipants: true,
      },
    })
    .returning();

test("rejects requests without a valid participant cookie", async () => {
  expect((await call(eventId, null)).status).toBe(401);
  expect((await call(eventId, `${cookieName(eventId)}=bad.token`)).status).toBe(401);
});

test("404 for malformed or unknown event ids", async () => {
  expect((await call("nope")).status).toBe(404);
  expect((await call("00000000-0000-4000-8000-000000000000")).status).toBe(404);
});

test("returns null when nothing is live (drafts and closed are not shown)", async () => {
  await poll("draft", 1);
  await poll("closed", 2);
  const res = await call();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ interaction: null });
});

test("returns the live poll with options but no private fields", async () => {
  await poll("draft", 1);
  const [row] = await poll("live", 2);
  const body = await (await call()).json();
  expect(body.interaction).toEqual({
    id: row.id,
    type: "poll",
    title: "Lunch?",
    state: "live",
    options: [
      { id: "a", label: "Pizza" },
      { id: "b", label: "Tacos" },
    ],
    multiSelect: false,
    showResultsToParticipants: true,
  });
});
