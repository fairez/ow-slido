// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, memberships, users, workspaces } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

let session: typeof import("@/lib/auth/session");
let eventRoute: typeof import("@/app/api/events/[id]/route");
let listRoute: typeof import("@/app/api/events/route");
let interactionsRoute: typeof import("@/app/api/events/[id]/interactions/route");
let exportRoute: typeof import("@/app/api/events/[id]/export.csv/route");
let activeRoute: typeof import("@/app/api/workspaces/active/route");
let ratingRoute: typeof import("@/app/api/interactions/[id]/rating/route");

let wsA: string;
let wsB: string;
let eventA: string;
let eventB: string;
let interactionB: string;
let userA: string;
let userBoth: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  session = await import("@/lib/auth/session");
  eventRoute = await import("@/app/api/events/[id]/route");
  listRoute = await import("@/app/api/events/route");
  interactionsRoute = await import("@/app/api/events/[id]/interactions/route");
  exportRoute = await import("@/app/api/events/[id]/export.csv/route");
  activeRoute = await import("@/app/api/workspaces/active/route");
  ratingRoute = await import("@/app/api/interactions/[id]/rating/route");
});
afterAll(() => pool.end());

beforeEach(async () => {
  await truncateAll(db);
  const [a, b, both] = await db
    .insert(users)
    .values([
      { email: "a@example.com", passwordHash: "x" },
      { email: "b@example.com", passwordHash: "x" },
      { email: "both@example.com", passwordHash: "x" },
    ])
    .returning();
  const [w1, w2] = await db.insert(workspaces).values([{ name: "A" }, { name: "B" }]).returning();
  wsA = w1.id;
  wsB = w2.id;
  userA = a.id;
  userBoth = both.id;
  await db.insert(memberships).values([
    { workspaceId: wsA, userId: a.id, role: "owner" },
    { workspaceId: wsB, userId: b.id, role: "owner" },
    { workspaceId: wsA, userId: both.id, role: "editor" },
    { workspaceId: wsB, userId: both.id, role: "editor" },
  ]);
  const when = { startsAt: new Date("2026-01-01"), endsAt: new Date("2026-01-02") };
  const [ea, eb] = await db
    .insert(events)
    .values([
      { workspaceId: wsA, ownerId: a.id, name: "EA", joinCode: "111111", ...when },
      { workspaceId: wsB, ownerId: b.id, name: "EB", joinCode: "222222", ...when },
    ])
    .returning();
  eventA = ea.id;
  eventB = eb.id;
  const [ib] = await db
    .insert(interactions)
    .values({ eventId: eventB, type: "poll", title: "P", position: 0 })
    .returning();
  interactionB = ib.id;
});

const cookie = (userId: string, workspaceId?: string) =>
  `${session.SESSION_COOKIE}=${session.createSessionToken(userId)}${workspaceId ? `; workspace=${workspaceId}` : ""}`;
const req = (userId: string, workspaceId?: string, init: RequestInit = {}) =>
  new Request("http://localhost/x", { ...init, headers: { cookie: cookie(userId, workspaceId), "content-type": "application/json" } });

test("a member of workspace A gets 404 on workspace B's event, interaction and export routes", async () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  expect((await eventRoute.GET(req(userA), ctx(eventB))).status).toBe(404);
  expect((await eventRoute.PATCH(req(userA, undefined, { method: "PATCH", body: JSON.stringify({ name: "x" }) }), ctx(eventB))).status).toBe(404);
  expect((await eventRoute.DELETE(req(userA, undefined, { method: "DELETE" }), ctx(eventB))).status).toBe(404);
  expect((await interactionsRoute.GET(req(userA), ctx(eventB))).status).toBe(404);
  expect((await exportRoute.GET(req(userA), ctx(eventB))).status).toBe(404);
  expect((await ratingRoute.GET(req(userA), ctx(interactionB))).status).toBe(404);
  expect((await eventRoute.GET(req(userA), ctx(eventA))).status).toBe(200);
});

test("the event list is scoped to the active workspace and creation uses it", async () => {
  const list = async (ws?: string) => ((await (await listRoute.GET(req(userBoth, ws))).json()) as { events: { id: string }[] }).events.map((e) => e.id);
  expect(await list(wsA)).toEqual([eventA]);
  expect(await list(wsB)).toEqual([eventB]);

  const create = await listRoute.POST(
    req(userBoth, wsB, {
      method: "POST",
      body: JSON.stringify({ name: "New", startsAt: "2026-02-01T10:00:00Z", endsAt: "2026-02-01T11:00:00Z" }),
    }),
  );
  expect(create.status).toBe(201);
  const { event } = (await create.json()) as { event: { workspaceId: string } };
  expect(event.workspaceId).toBe(wsB);
});

test("a cookie naming a workspace the user is not in falls back to their own", async () => {
  const res = await listRoute.GET(req(userA, wsB));
  const { events: list } = (await res.json()) as { events: { id: string }[] };
  expect(list.map((e) => e.id)).toEqual([eventA]);
});

test("a suspended member is rejected", async () => {
  await db.update(memberships).set({ status: "suspended" }).where(eq(memberships.userId, userA));
  expect((await listRoute.GET(req(userA))).status).toBe(403);
});

test("switching workspace sets the cookie only for active memberships", async () => {
  const ok = await activeRoute.POST(req(userBoth, undefined, { method: "POST", body: JSON.stringify({ workspaceId: wsB }) }));
  expect(ok.status).toBe(200);
  expect(ok.headers.get("set-cookie")).toContain(`workspace=${wsB}`);

  const denied = await activeRoute.POST(req(userA, undefined, { method: "POST", body: JSON.stringify({ workspaceId: wsB }) }));
  expect(denied.status).toBe(403);
  expect(denied.headers.get("set-cookie")).toBeNull();

  const anon = await activeRoute.POST(new Request("http://localhost/x", { method: "POST", body: "{}" }));
  expect(anon.status).toBe(401);
});
