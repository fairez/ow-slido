// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { interactions, participants, sharedNoteVotes, sharedNotes } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: Handler };
let notes: { GET: Handler };
let upvote: { POST: Handler };
let signup: (req: Request) => Promise<Response>;
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;
let hostCookie: string;
let eventId: string;
let notesId: string;
let published: { name: string; payload: unknown; hostOnly?: boolean }[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  notes = await import("@/app/api/interactions/[id]/notes/route");
  upvote = await import("@/app/api/notes/[id]/upvote/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
  tokens = await import("@/lib/participant-token");
  publisher = await import("@/lib/realtime/publisher");
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

const req = (method: string, body?: unknown, c: string | null = hostCookie, url = "http://localhost/api") =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

const join = async () => {
  const [p] = await db.insert(participants).values({ eventId }).returning();
  return {
    id: p.id,
    cookie: `${tokens.participantCookieName(eventId)}=${tokens.createParticipantToken(eventId, p.id)}`,
  };
};

const addNote = async (authorId: string, text: string, extra: Partial<typeof sharedNotes.$inferInsert> = {}) => {
  const [row] = await db.insert(sharedNotes).values({ interactionId: notesId, participantId: authorId, text, ...extra }).returning();
  return row.id;
};
const list = async (c: string | null, query = "") => {
  const res = await notes.GET(req("GET", undefined, c, `http://localhost/api?${query}`), ctx(notesId));
  return { res, body: res.status === 200 ? ((await res.json()) as { notes: Record<string, unknown>[] }).notes : null };
};
const vote = (noteId: string, c: string | null) => upvote.POST(req("POST", undefined, c), ctx(noteId));
const setState = (state: "draft" | "live" | "closed") =>
  db.update(interactions).set({ state }).where(eq(interactions.id, notesId));

let author: Awaited<ReturnType<typeof join>>;
let voter: Awaited<ReturnType<typeof join>>;

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  published = [];
  publisher.setPublisher({ publish: (_e, name, payload, o) => void published.push({ name, payload, hostOnly: o?.hostOnly }) });
  const host = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "host@example.com", password: "password123" }),
    }),
  );
  hostCookie = (host.headers.get("set-cookie") ?? "").split(";")[0];
  const ev = await eventsRoute.POST(
    req("POST", { name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }),
  );
  eventId = (await ev.json()).event.id;
  const res = await collection.POST(req("POST", { type: "sharedNotes", prompt: "Thoughts?" }), ctx(eventId));
  notesId = (await res.json()).interaction.id;
  await setState("live");
  author = await join();
  voter = await join();
});
afterAll(async () => {
  publisher.setPublisher(null);
  await pool.end();
});

test("upvote toggles on and off", async () => {
  const id = await addNote(author.id, "good");
  expect(await (await vote(id, voter.cookie)).json()).toEqual({ ok: true, upvoted: true, upvotes: 1 });
  expect(await (await vote(id, voter.cookie)).json()).toEqual({ ok: true, upvoted: false, upvotes: 0 });
  expect(await db.select().from(sharedNoteVotes)).toHaveLength(0);
});

test("own notes cannot be upvoted", async () => {
  const id = await addNote(author.id, "mine");
  expect((await vote(id, author.cookie)).status).toBe(403);
  expect(await db.select().from(sharedNoteVotes)).toHaveLength(0);
});

test("pending and rejected notes cannot be upvoted", async () => {
  const pending = await addNote(author.id, "p", { status: "pending" });
  const rejected = await addNote(author.id, "r", { status: "rejected" });
  expect((await vote(pending, voter.cookie)).status).toBe(404);
  expect((await vote(rejected, voter.cookie)).status).toBe(404);
});

test("upvoting works while live or closed, not in draft", async () => {
  const id = await addNote(author.id, "x");
  await setState("closed");
  expect((await vote(id, voter.cookie)).status).toBe(200);
  await setState("draft");
  expect((await vote(id, voter.cookie)).status).toBe(409);
});

test("upvote needs a joined participant and a real note", async () => {
  const id = await addNote(author.id, "x");
  expect((await vote(id, null)).status).toBe(401);
  expect((await vote("not-a-uuid", voter.cookie)).status).toBe(404);
  expect((await vote("00000000-0000-4000-8000-000000000000", voter.cookie)).status).toBe(404);
});

test("upvotes publish the new count to the room", async () => {
  const id = await addNote(author.id, "x");
  await vote(id, voter.cookie);
  expect(published).toContainEqual({
    name: "note:votes",
    payload: { interactionId: notesId, noteId: id, upvotes: 1 },
    hostOnly: undefined,
  });
});

test("list shows approved notes only, with mine and iUpvoted flags", async () => {
  const a = await addNote(author.id, "approved");
  await addNote(author.id, "pending", { status: "pending" });
  await addNote(author.id, "rejected", { status: "rejected" });
  await vote(a, voter.cookie);

  const { body } = await list(voter.cookie);
  expect(body).toHaveLength(1);
  expect(body![0]).toMatchObject({ id: a, text: "approved", upvotes: 1, mine: false, iUpvoted: true });
  expect(body![0]).not.toHaveProperty("participantId");
  expect(JSON.stringify(body)).not.toContain(author.id);

  const own = await list(author.cookie);
  expect(own.body![0]).toMatchObject({ mine: true, iUpvoted: false });
});

test("list sorts by popular or recent with pinned first", async () => {
  const third = await join();
  const old = await addNote(author.id, "old", { createdAt: new Date("2026-11-01T09:00:00Z") });
  const mid = await addNote(author.id, "mid", { createdAt: new Date("2026-11-01T09:10:00Z") });
  const fresh = await addNote(author.id, "fresh", { createdAt: new Date("2026-11-01T09:20:00Z") });
  const pinned = await addNote(author.id, "pinned", { createdAt: new Date("2026-11-01T08:00:00Z"), pinned: true });
  await vote(old, voter.cookie);
  await vote(old, third.cookie);
  await vote(mid, voter.cookie);

  const ids = async (q: string) => (await list(voter.cookie, q)).body!.map((n) => n.id);
  expect(await ids("sort=popular")).toEqual([pinned, old, mid, fresh]);
  expect(await ids("")).toEqual([pinned, old, mid, fresh]);
  expect(await ids("sort=recent")).toEqual([pinned, fresh, mid, old]);
  expect((await list(voter.cookie, "sort=bogus")).res.status).toBe(400);
});

test("list requires a participant and hides draft interactions", async () => {
  expect((await list(null)).res.status).toBe(401);
  await setState("draft");
  expect((await list(voter.cookie)).res.status).toBe(404);
});

test("note changes publish to the room; pending ones only to the host", async () => {
  const post = (await import("@/app/api/interactions/[id]/notes/route")).POST;
  const res = await post(req("POST", { text: "hello" }, author.cookie), ctx(notesId));
  const created = (await res.json()).note;
  expect(published.find((p) => p.name === "note:added")).toMatchObject({
    payload: { note: { id: created.id, text: "hello", upvotes: 0 } },
  });

  published.length = 0;
  await db.update(interactions).set({ config: { prompt: "Q", maxNotesPerParticipant: 3, moderation: "moderated", showAuthorNames: false } }).where(eq(interactions.id, notesId));
  await post(req("POST", { text: "wait" }, voter.cookie), ctx(notesId));
  expect(published.some((p) => p.name === "note:added")).toBe(false);
  expect(published.find((p) => p.name === "note:pending")?.hostOnly).toBe(true);
});
