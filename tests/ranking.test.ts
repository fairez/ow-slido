// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, participants, rankingResponses, workspaces } from "@/db/schema";
import { scoreRanking } from "@/lib/ranking";
import { interactionModule } from "@/lib/interaction-modules";
import { buildInteractionCsv } from "@/lib/export";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
type DupCtx = { params: Promise<{ id: string; interactionId: string }> };
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let item: { PATCH: (req: Request, ctx: DupCtx) => Promise<Response> };
let duplicate: { POST: (req: Request, ctx: DupCtx) => Promise<Response> };
let ranking: { POST: (r: Request, c: Ctx) => Promise<Response> };
let signup: (req: Request) => Promise<Response>;
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;
let hostCookie: string;
let eventId: string;
let rankingId: string;
let optionIds: string[];
let cookie: string;
let published: { name: string; payload: unknown; hostOnly?: boolean }[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  item = await import("@/app/api/events/[id]/interactions/[interactionId]/route");
  duplicate = await import("@/app/api/events/[id]/interactions/[interactionId]/duplicate/route");
  ranking = await import("@/app/api/interactions/[id]/ranking/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
  tokens = await import("@/lib/participant-token");
  publisher = await import("@/lib/realtime/publisher");
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

const req = (method: string, body?: unknown, c: string | null = hostCookie) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
const itemCtx = (interactionId: string): DupCtx => ({ params: Promise.resolve({ id: eventId, interactionId }) });

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

const join = async () => {
  const [p] = await db.insert(participants).values({ eventId }).returning();
  return `${tokens.participantCookieName(eventId)}=${tokens.createParticipantToken(eventId, p.id)}`;
};
const post = (order: unknown, c: string | null = cookie, id = rankingId) => ranking.POST(req("POST", { order }, c), ctx(id));
const create = (body: Record<string, unknown>) => collection.POST(req("POST", { type: "ranking", ...body }), ctx(eventId));

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  published = [];
  publisher.setPublisher({
    publish: (_e, name, payload, options) => void published.push({ name, payload, hostOnly: options?.hostOnly }),
  });
  hostCookie = await newHost("host@example.com");
  // Ranking is not on the Free plan.
  await setPlan(db, (await db.select({ id: workspaces.id }).from(workspaces))[0].id, "pro");
  const ev = await eventsRoute.POST(
    req("POST", { name: "E", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T10:00:00Z" }),
  );
  eventId = (await ev.json()).event.id;
  const res = await create({ prompt: "Rank these", options: ["Alpha", "Beta", "Gamma"] });
  const created = (await res.json()).interaction;
  rankingId = created.id;
  optionIds = created.config.options.map((o: { id: string }) => o.id);
  await db.update(interactions).set({ state: "live" }).where(eq(interactions.id, rankingId));
  cookie = await join();
  published = [];
});
afterAll(async () => {
  await pool.end();
});

const opts = [
  { id: "a", text: "A" },
  { id: "b", text: "B" },
  { id: "c", text: "C" },
];

test("scoreRanking gives first place N points and last place 1", () => {
  const scores = scoreRanking(opts, [["a", "b", "c"], ["a", "c", "b"]]);
  expect(scores.map((s) => [s.id, s.score, s.rank])).toEqual([
    ["a", 6, 1],
    ["b", 3, 2],
    ["c", 3, 2],
  ]);
});

test("scoreRanking shares a rank between ties, skips the next one, and keeps the host's option order", () => {
  const scores = scoreRanking(opts, [["a", "b", "c"], ["b", "a", "c"]]);
  expect(scores.map((s) => [s.id, s.score, s.rank])).toEqual([
    ["a", 5, 1],
    ["b", 5, 1],
    ["c", 2, 3],
  ]);
});

test("scoreRanking with no responses lists every option at zero, rank 1", () => {
  expect(scoreRanking(opts, []).map((s) => [s.id, s.score, s.rank])).toEqual([
    ["a", 0, 1],
    ["b", 0, 1],
    ["c", 0, 1],
  ]);
});

test("scoreRanking copes with partial data: short orders, unknown and repeated ids", () => {
  const scores = scoreRanking(opts, [["c"], ["zzz", "a", "a", "b"], []]);
  // ["c"]: c=3. ["zzz","a","a","b"]: zzz ignored, a at index 1 = 2, repeated a ignored, b at index 3 is past N.
  expect(Object.fromEntries(scores.map((s) => [s.id, s.score]))).toEqual({ a: 2, b: 0, c: 3 });
  expect(scores.map((s) => s.id)).toEqual(["c", "a", "b"]);
});

test("a ranking is created with 2 to 10 options of at most 80 characters, each with an id", async () => {
  const res = await create({ prompt: "P", options: ["One", "Two"] });
  expect(res.status).toBe(201);
  const { interaction } = await res.json();
  expect(interaction.type).toBe("ranking");
  expect(interaction.config.prompt).toBe("P");
  expect(interaction.config.options).toEqual([
    { id: expect.any(String), text: "One" },
    { id: expect.any(String), text: "Two" },
  ]);

  const tooFew = await create({ prompt: "P", options: ["One"] });
  expect(tooFew.status).toBe(400);
  const tooMany = await create({ prompt: "P", options: Array.from({ length: 11 }, (_, i) => `O${i}`) });
  expect(tooMany.status).toBe(400);
  expect((await create({ prompt: "P", options: Array.from({ length: 10 }, (_, i) => `O${i}`) })).status).toBe(201);
  expect((await create({ prompt: "P", options: ["ok", "x".repeat(81)] })).status).toBe(400);
  expect((await create({ prompt: "P", options: ["ok", "  "] })).status).toBe(400);
  expect((await create({ prompt: "P" })).status).toBe(400);
  expect((await create({ prompt: "", options: ["a", "b"] })).status).toBe(400);
  expect((await create({ prompt: "p".repeat(201), options: ["a", "b"] })).status).toBe(400);
});

test("PATCH replaces the options of a draft and keeps the prompt when only options change", async () => {
  const draft = (await (await create({ prompt: "Keep", options: ["a", "b"] })).json()).interaction;
  const res = await item.PATCH(req("PATCH", { options: ["x", "y", "z"] }), itemCtx(draft.id));
  expect(res.status).toBe(200);
  const { interaction } = await res.json();
  expect(interaction.config.prompt).toBe("Keep");
  expect(interaction.config.options.map((o: { text: string }) => o.text)).toEqual(["x", "y", "z"]);
  expect((await item.PATCH(req("PATCH", { options: ["only"] }), itemCtx(draft.id))).status).toBe(400);
  // A live ranking is no longer editable.
  expect((await item.PATCH(req("PATCH", { options: ["x", "y"] }), itemCtx(rankingId))).status).toBe(409);
});

test("duplicate copies prompt and options with new option ids and no responses", async () => {
  await post(optionIds);
  const res = await duplicate.POST(req("POST"), itemCtx(rankingId));
  expect(res.status).toBe(201);
  const { interaction } = await res.json();
  expect(interaction.state).toBe("draft");
  expect(interaction.config.options.map((o: { text: string }) => o.text)).toEqual(["Alpha", "Beta", "Gamma"]);
  const copyIds = interaction.config.options.map((o: { id: string }) => o.id);
  expect(copyIds.filter((id: string) => optionIds.includes(id))).toEqual([]);
  expect(await db.select().from(rankingResponses).where(eq(rankingResponses.interactionId, interaction.id))).toHaveLength(0);
});

test("stores an order, sets first_response_at and tells the host sockets only", async () => {
  const order = [optionIds[2], optionIds[0], optionIds[1]];
  const res = await post(order);
  expect(res.status).toBe(201);
  const [row] = await db.select().from(rankingResponses);
  expect(row.order).toEqual(order);
  const [p] = await db.select().from(participants);
  expect(p.firstResponseAt).not.toBeNull();
  expect(published.map((m) => [m.name, m.hostOnly])).toEqual([["ranking:results", true]]);
});

test("rejects an order that is not a permutation of the option ids", async () => {
  const [a, b, c] = optionIds;
  const bad: unknown[] = [[a, b], [a, b, c, c], [a, a, b], [a, b, "nope"], [a, b, 3], "abc", null, undefined, { 0: a }, []];
  for (const order of bad) expect((await post(order)).status).toBe(400);
  expect(await db.select().from(rankingResponses)).toHaveLength(0);
  await getRateLimitStore().reset(); // the ten rejected tries used up the per-participant limit
  expect((await post([c, b, a])).status).toBe(201);
});

test("a second submission from the same participant is a 409 and changes nothing", async () => {
  const first = [optionIds[0], optionIds[1], optionIds[2]];
  expect((await post(first)).status).toBe(201);
  expect((await post([...first].reverse())).status).toBe(409);
  const rows = await db.select().from(rankingResponses);
  expect(rows).toHaveLength(1);
  expect(rows[0].order).toEqual(first);
});

test("the database refuses a second row for the same participant", async () => {
  await post(optionIds);
  const [row] = await db.select().from(rankingResponses);
  await expect(
    db.insert(rankingResponses).values({ interactionId: row.interactionId, participantId: row.participantId, order: optionIds }),
  ).rejects.toThrow();
});

test("only accepts a ranking while live", async () => {
  for (const state of ["draft", "paused", "closed"] as const) {
    await db.update(interactions).set({ state }).where(eq(interactions.id, rankingId));
    expect((await post(optionIds)).status).toBe(409);
  }
  expect(await db.select().from(rankingResponses)).toHaveLength(0);
});

test("needs a participant of this event and a ranking interaction", async () => {
  expect((await post(optionIds, null)).status).toBe(401);
  const other = await collection.POST(req("POST", { type: "rating", prompt: "r" }), ctx(eventId));
  const ratingId = (await other.json()).interaction.id;
  expect((await post(optionIds, cookie, ratingId)).status).toBe(404);
  expect((await post(optionIds, cookie, "not-a-uuid")).status).toBe(404);
});

test("the module counts submissions, scores them and exports a CSV without participant ids", async () => {
  const second = await join();
  await post([optionIds[0], optionIds[1], optionIds[2]]);
  await post([optionIds[0], optionIds[2], optionIds[1]], second);
  const m = interactionModule("ranking");
  expect(await m.responseCount(rankingId)).toBe(2);
  expect(await m.results(rankingId)).toMatchObject({
    total: 2,
    options: [
      { text: "Alpha", score: 6, rank: 1 },
      { text: "Beta", score: 3, rank: 2 },
      { text: "Gamma", score: 3, rank: 2 },
    ],
  });
  const csv = await buildInteractionCsv("ranking", rankingId);
  expect(csv).toBe(
    "section,title,rank,option,score,rankings\r\n" +
      "ranking,Rank these,1,Alpha,6,2\r\nranking,Rank these,2,Beta,3,2\r\nranking,Rank these,2,Gamma,3,2\r\n",
  );
  const ids = (await db.select({ id: participants.id }).from(participants)).map((p) => p.id);
  for (const id of ids) expect(csv).not.toContain(id);
});

test("deleting the event cascades to rankings", async () => {
  await post(optionIds);
  expect(await db.select().from(rankingResponses)).toHaveLength(1);
  await db.delete(events).where(eq(events.id, eventId));
  expect(await db.select().from(rankingResponses)).toHaveLength(0);
});

test("the participant live view lists the options and returns the participant's own order after they submit", async () => {
  const { getLiveInteraction } = await import("@/lib/live-view");
  const [p] = await db.select({ id: participants.id }).from(participants);
  const before = await getLiveInteraction(eventId, p.id);
  expect(before).toMatchObject({ type: "ranking", prompt: "Rank these", mine: null });
  expect(before?.type === "ranking" && before.options.map((o) => o.text)).toEqual(["Alpha", "Beta", "Gamma"]);

  const order = [optionIds[2], optionIds[0], optionIds[1]];
  expect((await post(order)).status).toBe(201);
  const after = await getLiveInteraction(eventId, p.id);
  expect(after?.type === "ranking" && after.mine).toEqual(order);
  // An unknown participant sees no answer.
  const anonymous = await getLiveInteraction(eventId);
  expect(anonymous?.type === "ranking" && anonymous.mine).toBeNull();
});
