// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, memberships, participants, sharedNotes, users } from "@/db/schema";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
type NCtx = { params: Promise<{ id: string; noteId: string }> };
let queueRoute: typeof import("@/app/api/events/[id]/moderation/route");
let noteRoute: typeof import("@/app/api/events/[id]/notes/[noteId]/route");
let eventRoute: typeof import("@/app/api/events/[id]/route");
let listRoute: typeof import("@/app/api/interactions/[id]/notes/route");
let session: typeof import("@/lib/auth/session");
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let hostCookie: string;
let eventId: string;
let otherEventId: string;
let otherNoteId: string;
let notesId: string;
let viewer: string;
let authorId: string;
let published: { name: string; payload: unknown; hostOnly?: boolean }[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  queueRoute = await import("@/app/api/events/[id]/moderation/route");
  noteRoute = await import("@/app/api/events/[id]/notes/[noteId]/route");
  eventRoute = await import("@/app/api/events/[id]/route");
  listRoute = await import("@/app/api/interactions/[id]/notes/route");
  session = await import("@/lib/auth/session");
  tokens = await import("@/lib/participant-token");
  publisher = await import("@/lib/realtime/publisher");
});

const req = (method: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id = eventId): Ctx => ({ params: Promise.resolve({ id }) });
const nctx = (noteId: string, id = eventId): NCtx => ({ params: Promise.resolve({ id, noteId }) });
const host = () => ({ cookie: hostCookie });

const addNote = async (text: string, status: "pending" | "approved" | "rejected" = "pending") =>
  (await db.insert(sharedNotes).values({ interactionId: notesId, participantId: authorId, text, status }).returning())[0].id;
const statusOf = async (id: string) => (await db.select().from(sharedNotes).where(eq(sharedNotes.id, id)))[0]?.status;
const audience = async () => {
  const res = await listRoute.GET(req("GET", { cookie: viewer }), { params: Promise.resolve({ id: notesId }) });
  return ((await res.json()) as { notes: { id: string; text: string; pinned: boolean }[] }).notes;
};

beforeEach(async () => {
  await truncateAll(db);
  published = [];
  publisher.setPublisher({ publish: (_e, name, payload, o) => void published.push({ name, payload, hostOnly: o?.hostOnly }) });
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
  const mk = async (ev: string) =>
    (
      await db
        .insert(interactions)
        .values({ eventId: ev, type: "sharedNotes", title: "Thoughts?", state: "live", position: 0, config: { prompt: "Thoughts?", moderation: "moderated" } })
        .returning()
    )[0].id;
  notesId = await mk(eventId);
  const otherInteraction = await mk(otherEventId);
  const [other] = await db.insert(participants).values({ eventId: otherEventId }).returning();
  otherNoteId = (
    await db.insert(sharedNotes).values({ interactionId: otherInteraction, participantId: other.id, text: "elsewhere", status: "pending" }).returning()
  )[0].id;
  const [a] = await db.insert(participants).values({ eventId }).returning();
  authorId = a.id;
  const [v] = await db.insert(participants).values({ eventId }).returning();
  viewer = `${tokens.participantCookieName(eventId)}=${tokens.createParticipantToken(eventId, v.id)}`;
});

afterAll(async () => {
  publisher.setPublisher(null);
  await pool.end();
});

test("approving shows the note to participants and publishes note:added", async () => {
  const id = await addNote("hello");
  expect(await audience()).toEqual([]);
  const res = await noteRoute.PATCH(req("PATCH", host(), { status: "approved" }), nctx(id));
  expect(res.status).toBe(200);
  expect((await audience()).map((n) => n.text)).toEqual(["hello"]);
  const added = published.find((p) => p.name === "note:added");
  expect(added).toBeTruthy();
  expect(JSON.stringify(added)).not.toContain(authorId);
});

test("rejecting hides the note for good and tells no participant", async () => {
  const id = await addNote("spam");
  const res = await noteRoute.PATCH(req("PATCH", host(), { status: "rejected" }), nctx(id));
  expect(await res.json()).toEqual({ ok: true, note: null });
  expect(await statusOf(id)).toBe("rejected");
  expect(await audience()).toEqual([]);
  expect(published.filter((p) => p.name.startsWith("note:") && !p.hostOnly)).toEqual([]);
  expect((await noteRoute.PATCH(req("PATCH", host(), { status: "approved" }), nctx(id))).status).toBe(404);
});

test("pinning an approved note puts it first and publishes an update", async () => {
  const first = await addNote("one", "approved");
  await new Promise((r) => setTimeout(r, 5));
  await addNote("two", "approved");
  expect((await audience())[0].text).toBe("two");
  expect((await noteRoute.PATCH(req("PATCH", host(), { pinned: true }), nctx(first))).status).toBe(200);
  const list = await audience();
  expect(list[0]).toMatchObject({ id: first, pinned: true });
  expect(published.some((p) => p.name === "note:updated")).toBe(true);
  const queue = (await (await queueRoute.GET(req("GET", host()), ctx())).json()) as { notes: { id: string }[] };
  expect(queue.notes[0].id).toBe(first);
});

test("pinning a pending note is refused, and moderated notes cannot be moderated twice", async () => {
  const id = await addNote("wait");
  expect((await noteRoute.PATCH(req("PATCH", host(), { pinned: true }), nctx(id))).status).toBe(409);
  await noteRoute.PATCH(req("PATCH", host(), { status: "approved" }), nctx(id));
  expect((await noteRoute.PATCH(req("PATCH", host(), { status: "rejected" }), nctx(id))).status).toBe(409);
  expect((await noteRoute.PATCH(req("PATCH", host(), {}), nctx(id))).status).toBe(400);
  expect((await noteRoute.PATCH(req("PATCH", host(), { status: "pending" }), nctx(id))).status).toBe(400);
});

test("deleting removes the note; participants hear only about visible ones", async () => {
  const visible = await addNote("shown", "approved");
  const hidden = await addNote("queued");
  expect((await noteRoute.DELETE(req("DELETE", host()), nctx(visible))).status).toBe(204);
  expect(published.filter((p) => p.name === "note:removed")).toHaveLength(1);
  expect((await noteRoute.DELETE(req("DELETE", host()), nctx(hidden))).status).toBe(204);
  expect(published.filter((p) => p.name === "note:removed")).toHaveLength(1);
  expect(await db.select().from(sharedNotes).where(eq(sharedNotes.id, visible))).toHaveLength(0);
  expect((await noteRoute.DELETE(req("DELETE", host()), nctx(visible))).status).toBe(404);
});

test("the queue lists pending and approved notes, never rejected, never participant ids", async () => {
  await addNote("p");
  await addNote("a", "approved");
  await addNote("r", "rejected");
  const res = await queueRoute.GET(req("GET", host()), ctx());
  const body = (await res.json()) as { notes: { text: string; status: string }[] };
  expect(body.notes.map((n) => n.text).sort()).toEqual(["a", "p"]);
  expect(JSON.stringify(body)).not.toContain(authorId);
});

test("notes of another event are out of reach", async () => {
  expect((await noteRoute.PATCH(req("PATCH", host(), { status: "approved" }), nctx(otherNoteId))).status).toBe(404);
  expect((await noteRoute.DELETE(req("DELETE", host()), nctx(otherNoteId))).status).toBe(404);
  expect(await statusOf(otherNoteId)).toBe("pending");
});

test("a moderator member moderates notes but cannot edit the event", async () => {
  const [m] = await db.insert(users).values({ email: "m@example.com", passwordHash: "x" }).returning();
  const [ws] = await db.select().from(events).where(eq(events.id, eventId));
  await db.insert(memberships).values({ userId: m.id, workspaceId: ws.workspaceId, role: "moderator" });
  const mod = { cookie: `${session.SESSION_COOKIE}=${session.createSessionToken(m.id)}` };
  const id = await addNote("via mod");
  expect((await noteRoute.PATCH(req("PATCH", mod, { status: "approved" }), nctx(id))).status).toBe(200);
  expect((await noteRoute.PATCH(req("PATCH", mod, { pinned: true }), nctx(id))).status).toBe(200);
  expect((await noteRoute.DELETE(req("DELETE", mod), nctx(id))).status).toBe(204);
  expect((await eventRoute.PATCH(req("PATCH", mod, { name: "x" }), ctx())).status).toBe(403);
});

test("without credentials, or as another host, note moderation is refused", async () => {
  const id = await addNote("x");
  expect((await noteRoute.PATCH(req("PATCH", {}, { status: "approved" }), nctx(id))).status).toBe(401);
  expect((await noteRoute.DELETE(req("DELETE", { "x-moderator-token": "legacy" }), nctx(id))).status).toBe(401);
  const [stranger] = await db.insert(users).values({ email: "s@example.com", passwordHash: "x" }).returning();
  await workspaceFor(db, stranger.id);
  const cookie = `${session.SESSION_COOKIE}=${session.createSessionToken(stranger.id)}`;
  expect((await noteRoute.PATCH(req("PATCH", { cookie }, { status: "approved" }), nctx(id))).status).toBe(404);
  expect(await statusOf(id)).toBe("pending");
});
