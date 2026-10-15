// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request, ctx: { params: Promise<{ id: string; interactionId: string }> }) => Promise<Response>;
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: Handler; GET: Handler };
let item: { GET: Handler; PATCH: Handler; DELETE: Handler };
let duplicate: { POST: Handler };
let reorder: { POST: Handler };
let signup: (req: Request) => Promise<Response>;
let cookie: string;
let eventId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  item = await import("@/app/api/events/[id]/interactions/[interactionId]/route");
  duplicate = await import("@/app/api/events/[id]/interactions/[interactionId]/duplicate/route");
  reorder = await import("@/app/api/events/[id]/interactions/reorder/route");
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

function req(method: string, body?: unknown, c: string | null = cookie) {
  return new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = (id: string, interactionId = "") => ({
  params: Promise.resolve({ id, interactionId }),
});

async function newEvent(c = cookie) {
  const res = await eventsRoute.POST(
    req("POST", { name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }, c),
  );
  return (await res.json()).event.id as string;
}

const poll = { type: "poll", question: "Favourite?", options: ["A", "B"] };

async function createPoll(body: object = poll, id = eventId, c: string | null = cookie) {
  const res = await collection.POST(req("POST", body, c), ctx(id));
  return { res, json: await res.json() };
}

beforeEach(async () => {
  await truncateAll(db);
  cookie = await newHost("host@example.com");
  eventId = await newEvent();
});
afterAll(() => pool.end());

test("create stores a draft poll with option ids and default config", async () => {
  const { res, json } = await createPoll();
  expect(res.status).toBe(201);
  const i = json.interaction;
  expect(i.type).toBe("poll");
  expect(i.title).toBe("Favourite?");
  expect(i.state).toBe("draft");
  expect(i.config.multiSelect).toBe(false);
  expect(i.config.showResultsToParticipants).toBe(false);
  expect(i.config.options.map((o: { label: string }) => o.label)).toEqual(["A", "B"]);
  expect(new Set(i.config.options.map((o: { id: string }) => o.id)).size).toBe(2);
});

test("validation: question required, 2-10 options, non-empty labels", async () => {
  expect((await createPoll({ ...poll, question: "  " })).res.status).toBe(400);
  expect((await createPoll({ ...poll, options: ["A"] })).res.status).toBe(400);
  expect((await createPoll({ ...poll, options: Array(11).fill("x") })).res.status).toBe(400);
  expect((await createPoll({ ...poll, options: ["A", " "] })).res.status).toBe(400);
  expect((await createPoll({ ...poll, type: "qa" })).res.status).toBe(400);
  expect((await createPoll({ ...poll, options: Array(10).fill("x") })).res.status).toBe(201);
});

test("list returns interactions in position order", async () => {
  await createPoll({ ...poll, question: "one" });
  await createPoll({ ...poll, question: "two" });
  const res = await collection.GET(req("GET"), ctx(eventId));
  const { interactions: list } = await res.json();
  expect(list.map((i: { title: string }) => i.title)).toEqual(["one", "two"]);
  expect(list.map((i: { position: number }) => i.position)).toEqual([0, 1]);
});

test("edit updates a draft but keeps ids of retained options", async () => {
  const { json } = await createPoll();
  const i = json.interaction;
  const res = await item.PATCH(
    req("PATCH", {
      question: "New?",
      multiSelect: true,
      options: [i.config.options[0], { label: "C" }],
    }),
    ctx(eventId, i.id),
  );
  expect(res.status).toBe(200);
  const updated = (await res.json()).interaction;
  expect(updated.title).toBe("New?");
  expect(updated.config.multiSelect).toBe(true);
  expect(updated.config.options[0].id).toBe(i.config.options[0].id);
  expect(updated.config.options.map((o: { label: string }) => o.label)).toEqual(["A", "C"]);
});

test("only drafts can be edited or deleted", async () => {
  const { json } = await createPoll();
  const id = json.interaction.id;
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, id));
  expect((await item.PATCH(req("PATCH", { question: "x" }), ctx(eventId, id))).status).toBe(409);
  expect((await item.DELETE(req("DELETE"), ctx(eventId, id))).status).toBe(409);
});

test("delete removes a draft", async () => {
  const { json } = await createPoll();
  const id = json.interaction.id;
  expect((await item.DELETE(req("DELETE"), ctx(eventId, id))).status).toBe(204);
  expect((await item.GET(req("GET"), ctx(eventId, id))).status).toBe(404);
});

test("duplicate copies the poll as a draft with fresh option ids at the end", async () => {
  const { json } = await createPoll();
  const src = json.interaction;
  await db.update(interactions).set({ state: "closed" }).where(eq(interactions.id, src.id));
  const res = await duplicate.POST(req("POST"), ctx(eventId, src.id));
  expect(res.status).toBe(201);
  const copy = (await res.json()).interaction;
  expect(copy.id).not.toBe(src.id);
  expect(copy.state).toBe("draft");
  expect(copy.title).toBe(src.title);
  expect(copy.position).toBe(1);
  expect(copy.config.options.map((o: { label: string }) => o.label)).toEqual(["A", "B"]);
  expect(copy.config.options[0].id).not.toBe(src.config.options[0].id);
});

test("reorder rewrites positions", async () => {
  const a = (await createPoll({ ...poll, question: "a" })).json.interaction;
  const b = (await createPoll({ ...poll, question: "b" })).json.interaction;
  const res = await reorder.POST(req("POST", { ids: [b.id, a.id] }), ctx(eventId));
  expect(res.status).toBe(200);
  const list = (await (await collection.GET(req("GET"), ctx(eventId))).json()).interactions;
  expect(list.map((i: { title: string }) => i.title)).toEqual(["b", "a"]);
  expect((await reorder.POST(req("POST", { ids: [a.id] }), ctx(eventId))).status).toBe(400);
});

test("401 without a session; 404 for another host's event", async () => {
  expect((await createPoll(poll, eventId, null)).res.status).toBe(401);
  const { json } = await createPoll();
  const other = await newHost("other@example.com");
  expect((await createPoll(poll, eventId, other)).res.status).toBe(404);
  expect((await collection.GET(req("GET", undefined, other), ctx(eventId))).status).toBe(404);
  const id = json.interaction.id;
  expect((await item.PATCH(req("PATCH", { question: "x" }, other), ctx(eventId, id))).status).toBe(404);
  expect((await item.DELETE(req("DELETE", undefined, other), ctx(eventId, id))).status).toBe(404);
  expect((await duplicate.POST(req("POST", undefined, other), ctx(eventId, id))).status).toBe(404);
  expect((await reorder.POST(req("POST", { ids: [id] }, other), ctx(eventId))).status).toBe(404);
});

test("an interaction cannot be reached through a different event", async () => {
  const { json } = await createPoll();
  const otherEvent = await newEvent();
  const res = await item.GET(req("GET"), ctx(otherEvent, json.interaction.id));
  expect(res.status).toBe(404);
});
