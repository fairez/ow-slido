// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, openTextResponses, participants, pollVotes, questions, sharedNotes, users } from "@/db/schema";
import { responseCounts } from "@/lib/content-library";
import { createTestDb, qaFor, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<Record<string, string>> };
type Handlers = Record<string, (r: Request, c: Ctx) => Promise<Response>>;
let listRoute: Handlers;
let itemRoute: Handlers;
let duplicateRoute: Handlers;
let reorderRoute: Handlers;
let session: typeof import("@/lib/auth/session");
let publisher: typeof import("@/lib/realtime/publisher");
let cookie: string;
let eventId: string;
let participantId: string;
let published: { name: string; eventId: string; hostOnly?: boolean }[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  listRoute = (await import("@/app/api/events/[id]/interactions/route")) as unknown as Handlers;
  itemRoute = (await import("@/app/api/events/[id]/interactions/[interactionId]/route")) as unknown as Handlers;
  duplicateRoute = (await import("@/app/api/events/[id]/interactions/[interactionId]/duplicate/route")) as unknown as Handlers;
  reorderRoute = (await import("@/app/api/events/[id]/interactions/reorder/route")) as unknown as Handlers;
  session = await import("@/lib/auth/session");
  publisher = await import("@/lib/realtime/publisher");
});

afterAll(async () => {
  publisher.setPublisher(null);
  await pool.end();
});

const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (params: Record<string, string>): Ctx => ({ params: Promise.resolve(params) });

beforeEach(async () => {
  await truncateAll(db);
  published = [];
  publisher.setPublisher({ publish: (id, name, _p, o) => void published.push({ name, eventId: id, hostOnly: o?.hostOnly }) });
  const [user] = await db.insert(users).values({ email: "h@example.com", passwordHash: "x" }).returning();
  cookie = `${session.SESSION_COOKIE}=${session.createSessionToken(user.id)}`;
  const [event] = await db
    .insert(events)
    .values({
      workspaceId: await workspaceFor(db, user.id),
      ownerId: user.id,
      name: "Workshop",
      joinCode: "123456",
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T12:00:00Z"),
    })
    .returning();
  eventId = event.id;
  [{ id: participantId }] = await db.insert(participants).values({ eventId }).returning();
});

const add = async (type: "poll" | "openText" | "sharedNotes", position: number) =>
  (await db.insert(interactions).values({ eventId, type, title: `${type} ${position}`, position, config: {} }).returning())[0].id;

test("counts responses of every type per interaction and leaves rejected ones out", async () => {
  const poll = await add("poll", 0);
  const text = await add("openText", 1);
  const notes = await add("sharedNotes", 2);
  const qa = await qaFor(db, eventId);
  await add("poll", 3);
  await db.insert(pollVotes).values({ interactionId: poll, participantId, optionIds: ["a"] });
  await db.insert(openTextResponses).values([
    { interactionId: text, participantId, text: "one" },
    { interactionId: text, participantId, text: "two" },
  ]);
  await db.insert(sharedNotes).values([
    { interactionId: notes, participantId, text: "kept", status: "approved" },
    { interactionId: notes, participantId, text: "pending", status: "pending" },
    { interactionId: notes, participantId, text: "no", status: "rejected" },
  ]);
  await db.insert(questions).values([
    { eventId, interactionId: qa, participantId, text: "q1", status: "approved" },
    { eventId, interactionId: qa, participantId, text: "q2", status: "rejected" },
  ]);

  const counts = await responseCounts(eventId);
  expect(counts).toEqual({ [poll]: 1, [text]: 2, [notes]: 2, [qa]: 1 });
});

test("does not count another event's responses", async () => {
  const mine = await add("poll", 0);
  const [owner] = await db.select().from(users);
  const [other] = await db
    .insert(events)
    .values({
      workspaceId: await workspaceFor(db, owner.id),
      ownerId: owner.id,
      name: "Other",
      joinCode: "654321",
      startsAt: new Date("2026-11-02T10:00:00Z"),
      endsAt: new Date("2026-11-02T12:00:00Z"),
    })
    .returning();
  const [theirs] = await db.insert(interactions).values({ eventId: other.id, type: "poll", title: "p", position: 0, config: {} }).returning();
  const [guest] = await db.insert(participants).values({ eventId: other.id }).returning();
  await db.insert(pollVotes).values({ interactionId: theirs.id, participantId: guest.id, optionIds: ["a"] });
  expect(await responseCounts(eventId)).toEqual({});
  expect(await responseCounts(other.id)).toEqual({ [theirs.id]: 1 });
  expect(mine).toBeTruthy();
});

test("the list answers with the counts", async () => {
  const poll = await add("poll", 0);
  await db.insert(pollVotes).values({ interactionId: poll, participantId, optionIds: ["a"] });
  const res = await listRoute.GET(req("GET"), ctx({ id: eventId }));
  const body = (await res.json()) as { interactions: { id: string }[]; counts: Record<string, number> };
  expect(body.interactions.map((i) => i.id)).toEqual([poll]);
  expect(body.counts).toEqual({ [poll]: 1 });
});

test("create, rename, duplicate, reorder and delete each tell the host sockets to reload the list", async () => {
  const created = await listRoute.POST(req("POST", { type: "openText", prompt: "Why?" }), ctx({ id: eventId }));
  expect(created.status).toBe(201);
  const { interaction } = (await created.json()) as { interaction: { id: string } };
  const second = await add("poll", 5);
  const changed = () => published.filter((m) => m.name === "content:changed");
  expect(changed()).toHaveLength(1);

  const renamed = await itemRoute.PATCH(req("PATCH", { prompt: "Why not?" }), ctx({ id: eventId, interactionId: interaction.id }));
  expect(((await renamed.json()) as { interaction: { title: string } }).interaction.title).toBe("Why not?");
  expect(changed()).toHaveLength(2);

  await duplicateRoute.POST(req("POST"), ctx({ id: eventId, interactionId: interaction.id }));
  expect(changed()).toHaveLength(3);

  const all = (await db.select().from(interactions)).map((i) => i.id);
  await reorderRoute.POST(req("POST", { ids: [...all].reverse() }), ctx({ id: eventId }));
  expect(changed()).toHaveLength(4);

  await itemRoute.DELETE(req("DELETE"), ctx({ id: eventId, interactionId: second }));
  expect(changed()).toHaveLength(5);
  expect(changed().every((m) => m.hostOnly && m.eventId === eventId)).toBe(true);
});

test("a refused change does not publish", async () => {
  const live = (await db.insert(interactions).values({ eventId, type: "poll", title: "p", position: 0, state: "live", config: {} }).returning())[0];
  const res = await itemRoute.DELETE(req("DELETE"), ctx({ id: eventId, interactionId: live.id }));
  expect(res.status).toBe(409);
  expect(published.filter((m) => m.name === "content:changed")).toHaveLength(0);
});
