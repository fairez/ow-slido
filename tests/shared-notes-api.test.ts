// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { interactions, participants, sharedNotes } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let notes: { POST: Handler };
let note: { PATCH: Handler; DELETE: Handler };
let signup: (req: Request) => Promise<Response>;
let tokens: typeof import("@/lib/participant-token");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;
let hostCookie: string;
let eventId: string;
let notesId: string;
let cookie: string;
let participantId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  notes = await import("@/app/api/interactions/[id]/notes/route");
  note = await import("@/app/api/notes/[id]/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
  tokens = await import("@/lib/participant-token");
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

const req = (method: string, body?: unknown, c: string | null = hostCookie) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

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

const join = async (nickname?: string) => {
  const [p] = await db.insert(participants).values({ eventId, nickname }).returning();
  return {
    id: p.id,
    cookie: `${tokens.participantCookieName(eventId)}=${tokens.createParticipantToken(eventId, p.id)}`,
  };
};

const configure = (config: object) =>
  db
    .update(interactions)
    .set({ config: { prompt: "Thoughts?", maxNotesPerParticipant: 2, moderation: "open", showAuthorNames: false, ...config } })
    .where(eq(interactions.id, notesId));

const post = (text: unknown, c: string | null = cookie, id = notesId) =>
  notes.POST(req("POST", { text }, c), ctx(id));

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  hostCookie = await newHost("host@example.com");
  const ev = await eventsRoute.POST(
    req("POST", { name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }),
  );
  eventId = (await ev.json()).event.id;
  const res = await collection.POST(
    req("POST", { type: "sharedNotes", prompt: "Thoughts?", maxNotesPerParticipant: 2 }),
    ctx(eventId),
  );
  notesId = (await res.json()).interaction.id;
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, notesId));
  const p = await join();
  cookie = p.cookie;
  participantId = p.id;
});
afterAll(async () => {
  await pool.end();
});

test("submits a trimmed note, approved in open mode, and sets first_response_at", async () => {
  const res = await post("  Great talk  ");
  expect(res.status).toBe(201);
  expect((await res.json()).note).toMatchObject({ text: "Great talk", status: "approved", authorName: null });
  const [p] = await db.select().from(participants).where(eq(participants.id, participantId));
  expect(p.firstResponseAt).not.toBeNull();
});

test("rejects empty, whitespace-only and over-long text", async () => {
  expect((await post("")).status).toBe(400);
  expect((await post("   ")).status).toBe(400);
  expect((await post(42)).status).toBe(400);
  expect((await post("x".repeat(501))).status).toBe(400);
  expect((await post("x".repeat(500))).status).toBe(201);
});

test("enforces the per-participant limit", async () => {
  expect((await post("one")).status).toBe(201);
  expect((await post("two")).status).toBe(201);
  expect((await post("three")).status).toBe(409);
  const other = await join();
  expect((await post("mine", other.cookie)).status).toBe(201);
});

test("requires a joined participant and a notes interaction", async () => {
  expect((await post("hi", null)).status).toBe(401);
  expect((await post("hi", "participant_x=bad")).status).toBe(401);
  expect((await post("hi", cookie, "not-a-uuid")).status).toBe(404);
  expect((await post("hi", cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
});

test("is closed unless the interaction is live", async () => {
  await db.update(interactions).set({ state: "closed" }).where(eq(interactions.id, notesId));
  expect((await post("late")).status).toBe(409);
  await db.update(interactions).set({ state: "draft" }).where(eq(interactions.id, notesId));
  expect((await post("early")).status).toBe(409);
});

test("moderated mode creates pending notes; open mode approves", async () => {
  await configure({ moderation: "moderated" });
  expect((await (await post("wait")).json()).note.status).toBe("pending");
  await configure({ moderation: "open" });
  expect((await (await post("now")).json()).note.status).toBe("approved");
});

test("stores the nickname only when supplied and showAuthorNames is on", async () => {
  const named = await join("Sam");
  const anon = await join();
  await configure({ showAuthorNames: true });
  expect((await (await post("a", named.cookie)).json()).note.authorName).toBe("Sam");
  expect((await (await post("b", anon.cookie)).json()).note.authorName).toBeNull();
  await configure({ showAuthorNames: false });
  expect((await (await post("c", named.cookie)).json()).note.authorName).toBeNull();
});

test("uses the submitted name when author names are shown, and ignores it otherwise", async () => {
  const anon = await join();
  const send = (authorName: unknown) => notes.POST(req("POST", { text: "hi", authorName }, anon.cookie), ctx(notesId));
  await configure({ showAuthorNames: true, maxNotesPerParticipant: 10 });
  expect((await (await send("  Robin ")).json()).note.authorName).toBe("Robin");
  expect((await (await send("")).json()).note.authorName).toBeNull();
  expect((await send(42)).status).toBe(400);
  expect((await send("x".repeat(41))).status).toBe(400);
  expect((await send("fuck")).status).toBe(400);
  await configure({ showAuthorNames: false, maxNotesPerParticipant: 10 });
  expect((await (await send("Robin")).json()).note.authorName).toBeNull();
});

test("blocks profane notes with a clear message", async () => {
  const res = await post("what the fuck");
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/language/);
  expect(await db.select().from(sharedNotes)).toHaveLength(0);
});

test("rate limits per participant", async () => {
  await configure({ maxNotesPerParticipant: 10 });
  for (let i = 0; i < 10; i++) expect((await post(`n${i}`)).status).toBe(201);
  const res = await post("one more");
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBeTruthy();
});

test("rate limits per IP", async () => {
  for (let i = 0; i < 100; i++) await notes.POST(req("POST", { text: "" }, cookie), ctx(notesId));
  expect((await post("x")).status).toBe(429);
});

test("author edits their note; moderated edits return to pending", async () => {
  const id = (await (await post("first")).json()).note.id;
  const res = await note.PATCH(req("PATCH", { text: " better " }, cookie), ctx(id));
  expect(res.status).toBe(200);
  expect((await res.json()).note).toMatchObject({ text: "better", status: "approved" });

  await configure({ moderation: "moderated" });
  await db.update(sharedNotes).set({ status: "approved" }).where(eq(sharedNotes.id, id));
  const again = await note.PATCH(req("PATCH", { text: "again" }, cookie), ctx(id));
  expect((await again.json()).note.status).toBe("pending");
});

test("edit validates text and profanity", async () => {
  const id = (await (await post("first")).json()).note.id;
  expect((await note.PATCH(req("PATCH", { text: "" }, cookie), ctx(id))).status).toBe(400);
  expect((await note.PATCH(req("PATCH", { text: "shit" }, cookie), ctx(id))).status).toBe(400);
  const [row] = await db.select().from(sharedNotes).where(eq(sharedNotes.id, id));
  expect(row.text).toBe("first");
});

test("author deletes their note and frees a slot", async () => {
  const id = (await (await post("one")).json()).note.id;
  await post("two");
  expect((await note.DELETE(req("DELETE", undefined, cookie), ctx(id))).status).toBe(204);
  expect((await post("three")).status).toBe(201);
});

test("others cannot edit or delete a note", async () => {
  const id = (await (await post("mine")).json()).note.id;
  const other = await join();
  expect((await note.PATCH(req("PATCH", { text: "hijack" }, other.cookie), ctx(id))).status).toBe(404);
  expect((await note.DELETE(req("DELETE", undefined, other.cookie), ctx(id))).status).toBe(404);
  expect((await note.DELETE(req("DELETE", undefined, null), ctx(id))).status).toBe(401);
  expect((await note.DELETE(req("DELETE", undefined, hostCookie), ctx(id))).status).toBe(401);
  const [row] = await db.select().from(sharedNotes).where(eq(sharedNotes.id, id));
  expect(row.text).toBe("mine");
});

test("edit and delete are refused once the interaction is closed", async () => {
  const id = (await (await post("mine")).json()).note.id;
  await db.update(interactions).set({ state: "closed" }).where(eq(interactions.id, notesId));
  expect((await note.PATCH(req("PATCH", { text: "x" }, cookie), ctx(id))).status).toBe(409);
  expect((await note.DELETE(req("DELETE", undefined, cookie), ctx(id))).status).toBe(409);
  expect(await db.select().from(sharedNotes)).toHaveLength(1);
});

test("unknown note ids return 404", async () => {
  expect((await note.PATCH(req("PATCH", { text: "x" }, cookie), ctx("nope"))).status).toBe(404);
  expect((await note.DELETE(req("DELETE", undefined, cookie), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
});
