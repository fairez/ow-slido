// @vitest-environment node
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, participants, users } from "@/db/schema";
import { getRateLimitStore } from "@/lib/rate-limit";
import { createTestDb, truncateAll } from "./helpers/db";
import { JOIN_IP_LIMIT } from "@/lib/rate-limit";

const { db, pool } = createTestDb();

let join: (req: Request) => Promise<Response>;
let eventId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  join = (await import("@/app/api/join/route")).POST;
});

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  const [user] = await db
    .insert(users)
    .values({ email: "host@example.com", passwordHash: "x" })
    .returning();
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
});
afterAll(() => pool.end());

function req(body: unknown, cookie?: string, ip = "1.1.1.1") {
  return new Request("http://localhost/api/join", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const participantCount = async () => (await db.select({ n: count() }).from(participants))[0].n;

test("valid code returns the event and sets a participant cookie", async () => {
  const res = await join(req({ code: "123456" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.event).toEqual({ id: eventId, name: "Town hall", joinCode: "123456" });
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(`participant_${eventId}=`);
  expect(setCookie).toContain("HttpOnly");
  const rows = await db.select().from(participants).where(eq(participants.id, body.participant.id));
  expect(rows).toHaveLength(1);
  expect(rows[0].eventId).toBe(eventId);
  expect(rows[0].nickname).toBeNull();
  expect(rows[0].firstResponseAt).toBeNull();
});

test("invalid or malformed code returns 404", async () => {
  for (const code of ["999999", "abc", "", undefined, 123456]) {
    const res = await join(req({ code }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Event not found" });
  }
  expect(await participantCount()).toBe(0);
});

test("re-joining with a valid token reuses the participant", async () => {
  const first = await join(req({ code: "123456" }));
  const second = await join(req({ code: "123456" }, cookieOf(first)));
  expect((await second.json()).participant.id).toBe((await first.json()).participant.id);
  expect(await participantCount()).toBe(1);
});

test("a tampered or foreign token creates a new participant", async () => {
  const first = await join(req({ code: "123456" }));
  const id = (await first.json()).participant.id;
  const forged = await join(req({ code: "123456" }, `participant_${eventId}=${id}.bogus`));
  expect((await forged.json()).participant.id).not.toBe(id);
  expect(await participantCount()).toBe(2);
});

test("a token for a deleted participant is replaced", async () => {
  const first = await join(req({ code: "123456" }));
  await db.delete(participants);
  const again = await join(req({ code: "123456" }, cookieOf(first)));
  expect(again.status).toBe(200);
  expect(await participantCount()).toBe(1);
});

test("join is rate limited per IP", async () => {
  for (let i = 0; i < JOIN_IP_LIMIT; i++) {
    expect((await join(req({ code: "000000" }))).status).toBe(404);
  }
  const limited = await join(req({ code: "123456" }));
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBeTruthy();
  expect((await join(req({ code: "123456" }, undefined, "2.2.2.2"))).status).toBe(200);
});
