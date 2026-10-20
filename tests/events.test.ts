// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, users, workspaces } from "@/db/schema";
import { createTestDb, qaFor, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request) => Promise<Response>;
type ItemHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let collection: { POST: Handler; GET: Handler };
let item: { GET: ItemHandler; PATCH: ItemHandler; DELETE: ItemHandler };
let signup: Handler;
let cookie: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  collection = await import("@/app/api/events/route");
  item = await import("@/app/api/events/[id]/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
});

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

beforeEach(async () => {
  await truncateAll(db);
  cookie = await newHost("host@example.com");
});
afterAll(() => pool.end());

function req(method: string, path: string, body?: unknown, c: string | null = cookie) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const valid = {
  name: "Town hall",
  startsAt: "2026-11-01T09:00:00Z",
  endsAt: "2026-11-01T10:00:00Z",
};

async function create(body: object = valid, c: string | null = cookie) {
  const res = await collection.POST(req("POST", "/api/events", body, c));
  return { res, json: await res.json() };
}

test("create returns the event with a unique 4-6 digit join code and open moderation", async () => {
  const { res, json } = await create();
  expect(res.status).toBe(201);
  expect(json.event.name).toBe("Town hall");
  expect(json.event.joinCode).toMatch(/^[0-9]{4,6}$/);
  expect(json.event.moderationMode).toBe("open");
  const { json: second } = await create();
  expect(second.event.joinCode).not.toBe(json.event.joinCode);
});

test("generateUniqueJoinCode skips taken codes", async () => {
  const { generateUniqueJoinCode } = await import("@/lib/events");
  const candidates = ["111111", "222222", "123456"];
  const taken = new Set(["111111", "222222"]);
  const code = await generateUniqueJoinCode(
    async (c) => !taken.has(c),
    () => candidates.shift()!,
  );
  expect(code).toBe("123456");
});

test("list is sorted by start date and only shows the caller's events", async () => {
  await create({ ...valid, name: "Late", startsAt: "2026-12-01T09:00:00Z", endsAt: "2026-12-01T10:00:00Z" });
  await create({ ...valid, name: "Early" });
  const other = await newHost("other@example.com");
  await create({ ...valid, name: "Not mine" }, other);

  const res = await collection.GET(req("GET", "/api/events"));
  expect(res.status).toBe(200);
  const { events: list } = await res.json();
  expect(list.map((e: { name: string }) => e.name)).toEqual(["Early", "Late"]);
});

test("get returns one event; other owners get 404", async () => {
  const { json } = await create();
  const ok = await item.GET(req("GET", `/api/events/${json.event.id}`), ctx(json.event.id));
  expect(ok.status).toBe(200);
  const other = await newHost("other@example.com");
  const denied = await item.GET(req("GET", `/api/events/${json.event.id}`, undefined, other), ctx(json.event.id));
  expect(denied.status).toBe(404);
  const bad = await item.GET(req("GET", "/api/events/nope"), ctx("nope"));
  expect(bad.status).toBe(404);
});

test("patch renames and updates moderation mode and dates", async () => {
  const { json } = await create();
  const id = json.event.id;
  const res = await item.PATCH(
    req("PATCH", `/api/events/${id}`, { name: "Renamed", moderationMode: "moderated" }),
    ctx(id),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.event.name).toBe("Renamed");
  expect(body.event.moderationMode).toBe("moderated");
  expect(body.event.joinCode).toBe(json.event.joinCode);

  const badDates = await item.PATCH(
    req("PATCH", `/api/events/${id}`, { endsAt: "2026-10-01T00:00:00Z" }),
    ctx(id),
  );
  expect(badDates.status).toBe(400);
});

test("patch by another owner is 404 and changes nothing", async () => {
  const { json } = await create();
  const other = await newHost("other@example.com");
  const res = await item.PATCH(req("PATCH", `/api/events/${json.event.id}`, { name: "Hax" }, other), ctx(json.event.id));
  expect(res.status).toBe(404);
  const [row] = await db.select().from(events).where(eq(events.id, json.event.id));
  expect(row.name).toBe("Town hall");
});

test("delete removes the event; deleting the owner account keeps it, deleting the workspace removes it", async () => {
  const { json } = await create();
  const res = await item.DELETE(req("DELETE", `/api/events/${json.event.id}`), ctx(json.event.id));
  expect(res.status).toBe(204);
  expect(await db.select().from(events)).toHaveLength(0);
  const again = await item.DELETE(req("DELETE", `/api/events/${json.event.id}`), ctx(json.event.id));
  expect(again.status).toBe(404);

  await create();
  await db.delete(users);
  const [kept] = await db.select().from(events);
  expect(kept.ownerId).toBeNull();
  await db.delete(workspaces);
  expect(await db.select().from(events)).toHaveLength(0);
});

test("validation: name required, max 80, ends not before starts, bad dates", async () => {
  expect((await create({ ...valid, name: "" })).res.status).toBe(400);
  expect((await create({ ...valid, name: "   " })).res.status).toBe(400);
  expect((await create({ ...valid, name: "x".repeat(81) })).res.status).toBe(400);
  expect((await create({ ...valid, name: "x".repeat(80) })).res.status).toBe(201);
  expect((await create({ ...valid, endsAt: "2026-10-31T00:00:00Z" })).res.status).toBe(400);
  expect((await create({ ...valid, startsAt: "not a date" })).res.status).toBe(400);
  expect((await create({ ...valid, startsAt: undefined })).res.status).toBe(400);
  expect((await create({ ...valid, moderationMode: "weird" })).res.status).toBe(400);
});

test("every endpoint returns 401 without a session", async () => {
  const { json } = await create();
  const id = json.event.id;
  const results = await Promise.all([
    collection.POST(req("POST", "/api/events", valid, null)),
    collection.GET(req("GET", "/api/events", undefined, null)),
    item.GET(req("GET", `/api/events/${id}`, undefined, null), ctx(id)),
    item.PATCH(req("PATCH", `/api/events/${id}`, { name: "x" }, null), ctx(id)),
    item.DELETE(req("DELETE", `/api/events/${id}`, undefined, null), ctx(id)),
  ]);
  expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
});

test("duplicate copies interactions as drafts with a new join code and no responses", async () => {
  const { pollVotes, participants, questions } = await import("@/db/schema");
  const duplicate = (await import("@/app/api/events/[id]/duplicate/route")).POST;
  const { json } = await create({ ...valid, moderationMode: "moderated" });
  const src = json.event;
  const [live] = await db
    .insert(interactions)
    .values({ eventId: src.id, type: "poll", title: "Q?", position: 1, state: "live", config: { options: [{ id: "a", label: "A" }] } })
    .returning();
  await db.insert(interactions).values({ eventId: src.id, type: "wordcloud", title: "Cloud", position: 2, state: "closed" });
  const [p] = await db.insert(participants).values({ eventId: src.id }).returning();
  await db.insert(pollVotes).values({ interactionId: live.id, participantId: p.id, optionIds: ["a"] });
  await db.insert(questions).values({ eventId: src.id, interactionId: await qaFor(db, src.id), participantId: p.id, text: "Why?", status: "approved" });

  const res = await duplicate(req("POST", `/api/events/${src.id}/duplicate`), ctx(src.id));
  expect(res.status).toBe(201);
  const copy = (await res.json()).event;
  expect(copy.id).not.toBe(src.id);
  expect(copy.joinCode).not.toBe(src.joinCode);
  expect(copy.moderationMode).toBe("moderated");

  const copied = await db.select().from(interactions).where(eq(interactions.eventId, copy.id)).orderBy(interactions.position);
  expect(copied.map((i) => [i.title, i.state, i.position])).toEqual([["Q&A", "draft", 0], ["Q?", "draft", 1], ["Cloud", "draft", 2]]);
  expect(copied[1].config).toEqual({ options: [{ id: "a", label: "A" }] });
  expect(await db.select().from(participants).where(eq(participants.eventId, copy.id))).toHaveLength(0);
  expect(await db.select().from(questions).where(eq(questions.eventId, copy.id))).toHaveLength(0);
  const votes = await db.select().from(pollVotes);
  expect(votes).toHaveLength(1);
  expect(votes[0].interactionId).toBe(live.id);
  // source untouched
  const [orig] = await db.select().from(interactions).where(eq(interactions.id, live.id));
  expect(orig.state).toBe("live");
});

test("duplicate is owner-only", async () => {
  const duplicate = (await import("@/app/api/events/[id]/duplicate/route")).POST;
  const { json } = await create();
  const other = await newHost("other@example.com");
  const res = await duplicate(req("POST", "/x", undefined, other), ctx(json.event.id));
  expect(res.status).toBe(404);
  const anon = await duplicate(req("POST", "/x", undefined, null), ctx(json.event.id));
  expect(anon.status).toBe(401);
});
