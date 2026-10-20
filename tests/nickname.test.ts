// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, participants, quizAnswers, users } from "@/db/schema";
import { validateNickname } from "@/lib/nickname";
import { interactionModule } from "@/lib/interaction-modules";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
let route: { PUT: (req: Request, ctx: Ctx) => Promise<Response> };
let tokens: typeof import("@/lib/participant-token");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;
let eventId: string;
let quizId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  route = await import("@/app/api/events/[id]/nickname/route");
  tokens = await import("@/lib/participant-token");
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});
afterAll(async () => {
  await pool.end();
});

const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
const join = async (forEvent = eventId) => {
  const [p] = await db.insert(participants).values({ eventId: forEvent }).returning();
  return { id: p.id, cookie: `${tokens.participantCookieName(forEvent)}=${tokens.createParticipantToken(forEvent, p.id)}` };
};
const put = (nickname: unknown, cookie: string | null, id = eventId) =>
  route.PUT(
    new Request("http://localhost/api", {
      method: "PUT",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ nickname }),
    }),
    ctx(id),
  );
const nicknameOf = async (id: string) => (await db.select().from(participants).where(eq(participants.id, id)))[0].nickname;

async function newEvent() {
  const [user] = await db.insert(users).values({ email: `h${Math.random()}@example.com`, passwordHash: "x" }).returning();
  const [ev] = await db
    .insert(events)
    .values({
      ownerId: user.id,
      workspaceId: await workspaceFor(db, user.id),
      name: "E",
      joinCode: String(Math.floor(1000 + Math.random() * 8999)),
      startsAt: new Date("2026-11-01T09:00:00Z"),
      endsAt: new Date("2026-11-01T10:00:00Z"),
    })
    .returning();
  return ev.id;
}

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  eventId = await newEvent();
  const [q] = await db
    .insert(interactions)
    .values({
      eventId,
      type: "quiz",
      title: "Islands",
      state: "live",
      position: 0,
      startedAt: new Date(),
      deadlineAt: new Date(Date.now() + 20_000),
      config: { prompt: "p", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correctOptionIds: ["a"], timeLimitSeconds: 20, points: 1000 },
    })
    .returning();
  quizId = q.id;
});

test("validateNickname trims, collapses spaces and enforces 1 to 20 characters", () => {
  expect(validateNickname("  Rina   Putri ")).toEqual({ ok: true, nickname: "Rina Putri" });
  expect(validateNickname("a".repeat(20)).ok).toBe(true);
  expect(validateNickname("a".repeat(21))).toMatchObject({ ok: false, error: "api.nicknameTooLong", params: { max: 20 } });
  expect(validateNickname("   ")).toMatchObject({ ok: false, error: "api.nicknameEmpty" });
  expect(validateNickname(undefined)).toMatchObject({ ok: false, error: "api.nicknameEmpty" });
  expect(validateNickname(42)).toMatchObject({ ok: false, error: "api.nicknameEmpty" });
  expect(validateNickname("bad\u0007name")).toMatchObject({ ok: false, error: "api.nicknameInvalid" });
  // Counted in characters, not UTF-16 units.
  expect(validateNickname("😀".repeat(20)).ok).toBe(true);
});

test("saves the nickname on the participant", async () => {
  const p = await join();
  const res = await put("  Rina ", p.cookie);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ nickname: "Rina" });
  expect(await nicknameOf(p.id)).toBe("Rina");
});

test("empty, too long and profane nicknames are rejected with a message and not stored", async () => {
  const p = await join();
  for (const [value, text] of [
    ["", "Enter a nickname"],
    ["x".repeat(21), "A nickname can have at most 20 characters"],
    ["Big Shit", "Choose a different nickname"],
  ] as const) {
    const res = await put(value, p.cookie);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(text);
  }
  expect(await nicknameOf(p.id)).toBeNull();
});

test("a nickname already used in the event is rejected, ignoring case and spaces; another event may reuse it", async () => {
  const a = await join();
  const b = await join();
  expect((await put("Rina", a.cookie)).status).toBe(200);
  const taken = await put("  rINA ", b.cookie);
  expect(taken.status).toBe(409);
  expect((await taken.json()).error).toMatch(/already uses that nickname/);
  expect(await nicknameOf(b.id)).toBeNull();

  const other = await newEvent();
  const c = await join(other);
  expect((await put("Rina", c.cookie, other)).status).toBe(200);
});

test("the database refuses two equal names in one event even if the check is skipped", async () => {
  const a = await join();
  const b = await join();
  await db.update(participants).set({ nickname: "Rina" }).where(eq(participants.id, a.id));
  await expect(db.update(participants).set({ nickname: "RINA" }).where(eq(participants.id, b.id))).rejects.toThrow();
});

test("two participants saving the same name at once: one wins, the other gets 409", async () => {
  const a = await join();
  const b = await join();
  const results = await Promise.all([put("Sam", a.cookie), put("Sam", b.cookie)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
});

test("the same participant may save its own name again and may change it before answering", async () => {
  const p = await join();
  expect((await put("Rina", p.cookie)).status).toBe(200);
  expect((await put("Rina", p.cookie)).status).toBe(200);
  expect((await put("Dewi", p.cookie)).status).toBe(200);
  expect(await nicknameOf(p.id)).toBe("Dewi");
});

test("the nickname is fixed after the first quiz answer", async () => {
  const p = await join();
  await put("Rina", p.cookie);
  await db.insert(quizAnswers).values({ interactionId: quizId, participantId: p.id, optionIds: ["a"], elapsedMs: 1000, correct: true, points: 900 });
  const res = await put("Dewi", p.cookie);
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("You cannot change your nickname after your first answer");
  expect(await nicknameOf(p.id)).toBe("Rina");
});

test("needs a participant token for this event", async () => {
  expect((await put("Rina", null)).status).toBe(401);
  const other = await newEvent();
  const stranger = await join(other);
  expect((await put("Rina", stranger.cookie)).status).toBe(401);
  expect((await put("Rina", null, "not-a-uuid")).status).toBe(404);
});

test("the live quiz payload carries the nickname and whether it is locked; the same token keeps the name", async () => {
  const p = await join();
  const [row] = await db.select().from(interactions).where(eq(interactions.id, quizId));
  const live = () => interactionModule("quiz").live(row, p.id);
  expect(await live()).toMatchObject({ nickname: null, nicknameLocked: false });
  await put("Rina", p.cookie);
  expect(await live()).toMatchObject({ nickname: "Rina", nicknameLocked: false });
  await db.insert(quizAnswers).values({ interactionId: quizId, participantId: p.id, optionIds: ["a"], elapsedMs: 1, correct: true, points: 1 });
  expect(await live()).toMatchObject({ nickname: "Rina", nicknameLocked: true });
  expect(await interactionModule("quiz").live(row, undefined)).toMatchObject({ nickname: null, nicknameLocked: false });
});
