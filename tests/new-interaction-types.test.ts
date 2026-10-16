// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string; interactionId: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: Handler };
let item: { PATCH: Handler };
let duplicate: { POST: Handler };
let start: { POST: Handler };
let close: { POST: Handler };
let signup: (req: Request) => Promise<Response>;
let hostCookie: string;
let eventId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  item = await import("@/app/api/events/[id]/interactions/[interactionId]/route");
  duplicate = await import("@/app/api/events/[id]/interactions/[interactionId]/duplicate/route");
  start = await import("@/app/api/events/[id]/interactions/[interactionId]/start/route");
  close = await import("@/app/api/events/[id]/interactions/[interactionId]/close/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
});
afterAll(() => pool.end());

const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", cookie: hostCookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string, interactionId = id): Ctx => ({ params: Promise.resolve({ id, interactionId }) });

beforeEach(async () => {
  await truncateAll(db);
  const res = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "host@b.co", password: "password123" }),
    }),
  );
  hostCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const created = await eventsRoute.POST(
    req("POST", { name: "E", startsAt: "2026-01-01T10:00:00Z", endsAt: "2026-01-01T12:00:00Z" }),
  );
  eventId = (await created.json()).event.id;
});

const create = async (body: object) => {
  const res = await collection.POST(req("POST", body), ctx(eventId));
  return { res, json: await res.json() };
};

const VALID = {
  sharedNotes: { type: "sharedNotes", prompt: "Ideas?", maxNotesPerParticipant: 5, moderation: "moderated", showAuthorNames: true },
  openText: { type: "openText", prompt: "Thoughts?", maxResponsesPerParticipant: 2 },
  rating: { type: "rating", prompt: "How was it?", scale: "numeric10" },
} as const;

test.each(Object.values(VALID))("creates a $type interaction with its config", async (body) => {
  const { res, json } = await create(body);
  expect(res.status).toBe(201);
  const { type, prompt, ...config } = body;
  expect(json.interaction).toMatchObject({ type, title: prompt, state: "draft", config: { prompt, ...config } });
});

test("applies defaults to omitted config fields", async () => {
  const notes = await create({ type: "sharedNotes", prompt: "Ideas?" });
  expect(notes.json.interaction.config).toEqual({
    prompt: "Ideas?",
    maxNotesPerParticipant: 3,
    moderation: "open",
    showAuthorNames: false,
  });
  const rating = await create({ type: "rating", prompt: "Rate" });
  expect(rating.json.interaction.config.scale).toBe("stars5");
});

test.each([
  ["sharedNotes", { prompt: "" }],
  ["sharedNotes", { prompt: "x".repeat(201) }],
  ["sharedNotes", { prompt: "p", maxNotesPerParticipant: 0 }],
  ["sharedNotes", { prompt: "p", maxNotesPerParticipant: 11 }],
  ["sharedNotes", { prompt: "p", maxNotesPerParticipant: 1.5 }],
  ["sharedNotes", { prompt: "p", moderation: "strict" }],
  ["sharedNotes", { prompt: "p", showAuthorNames: "yes" }],
  ["openText", { prompt: "p", maxResponsesPerParticipant: 0 }],
  ["openText", { prompt: "p", maxResponsesPerParticipant: 4 }],
  ["rating", { prompt: "p", scale: "stars3" }],
  ["rating", {}],
])("rejects invalid %s config %j with 400", async (type, rest) => {
  const { res } = await create({ type, ...rest });
  expect(res.status).toBe(400);
});

test("PATCH validates and merges config on a draft", async () => {
  const { json } = await create(VALID.sharedNotes);
  const id = json.interaction.id;
  const bad = await item.PATCH(req("PATCH", { maxNotesPerParticipant: 99 }), ctx(eventId, id));
  expect(bad.status).toBe(400);
  const ok = await item.PATCH(req("PATCH", { moderation: "open" }), ctx(eventId, id));
  expect(ok.status).toBe(200);
  expect((await ok.json()).interaction.config).toMatchObject({
    prompt: "Ideas?",
    maxNotesPerParticipant: 5,
    moderation: "open",
  });
});

test.each(Object.values(VALID))("start and close work for $type, one live per event", async (body) => {
  const { json } = await create(body);
  const id = json.interaction.id;
  const other = await create({ type: "rating", prompt: "Other" });
  const otherId = other.json.interaction.id;

  expect((await start.POST(req("POST"), ctx(eventId, id))).status).toBe(200);
  expect((await start.POST(req("POST"), ctx(eventId, otherId))).status).toBe(200);
  const rows = await db.query.interactions.findMany();
  expect(rows.find((r) => r.id === id)?.state).toBe("closed");
  expect(rows.find((r) => r.id === otherId)?.state).toBe("live");
  expect((await close.POST(req("POST"), ctx(eventId, otherId))).status).toBe(200);
});

test.each(Object.values(VALID))("duplicate copies $type config as a new draft", async (body) => {
  const { json } = await create(body);
  const res = await duplicate.POST(req("POST"), ctx(eventId, json.interaction.id));
  expect(res.status).toBe(201);
  const copy = (await res.json()).interaction;
  expect(copy.id).not.toBe(json.interaction.id);
  expect(copy).toMatchObject({ type: body.type, state: "draft", config: json.interaction.config });
});
