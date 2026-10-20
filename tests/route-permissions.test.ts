// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, memberships, users, workspaces } from "@/db/schema";
import type { Role } from "@/lib/auth/permissions";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

let session: typeof import("@/lib/auth/session");
let listRoute: typeof import("@/app/api/events/route");
let eventRoute: typeof import("@/app/api/events/[id]/route");
let interactionsRoute: typeof import("@/app/api/events/[id]/interactions/route");
let interactionRoute: typeof import("@/app/api/events/[id]/interactions/[interactionId]/route");
let startRoute: typeof import("@/app/api/events/[id]/interactions/[interactionId]/start/route");

const ROLES: Role[] = ["owner", "admin", "editor", "moderator", "viewer"];
const userIds = {} as Record<Role, string>;
let creatorId: string;
let workspaceId: string;
let eventId: string;
let interactionId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  session = await import("@/lib/auth/session");
  listRoute = await import("@/app/api/events/route");
  eventRoute = await import("@/app/api/events/[id]/route");
  interactionsRoute = await import("@/app/api/events/[id]/interactions/route");
  interactionRoute = await import("@/app/api/events/[id]/interactions/[interactionId]/route");
  startRoute = await import("@/app/api/events/[id]/interactions/[interactionId]/start/route");
});
afterAll(() => pool.end());

beforeEach(async () => {
  await truncateAll(db);
  const [ws] = await db.insert(workspaces).values({ name: "W" }).returning();
  workspaceId = ws.id;
  const [creator] = await db.insert(users).values({ email: "creator@example.com", passwordHash: "x" }).returning();
  creatorId = creator.id;
  await db.insert(memberships).values({ workspaceId, userId: creatorId, role: "admin" });
  for (const role of ROLES) {
    const [u] = await db.insert(users).values({ email: `${role}@example.com`, passwordHash: "x" }).returning();
    userIds[role] = u.id;
    await db.insert(memberships).values({ workspaceId, userId: u.id, role });
  }
  await seed(creatorId);
});

async function seed(createdBy: string) {
  const [event] = await db
    .insert(events)
    .values({
      workspaceId,
      ownerId: creatorId,
      createdBy,
      name: "E",
      joinCode: String(100000 + Math.floor(Math.random() * 899999)),
      startsAt: new Date("2026-01-01"),
      endsAt: new Date("2026-01-02"),
    })
    .returning();
  const [interaction] = await db
    .insert(interactions)
    .values({ eventId: event.id, createdBy, type: "poll", title: "P", position: 0, config: { options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } })
    .returning();
  eventId = event.id;
  interactionId = interaction.id;
}

const req = (userId: string | null, body?: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(userId ? { cookie: `${session.SESSION_COOKIE}=${session.createSessionToken(userId)}; workspace=${workspaceId}` } : {}),
    },
  });
const evCtx = () => ({ params: Promise.resolve({ id: eventId }) });
const itCtx = () => ({ params: Promise.resolve({ id: eventId, interactionId }) });
const eventBody = { name: "New", startsAt: "2026-02-01T10:00:00Z", endsAt: "2026-02-01T11:00:00Z" };
const pollBody = { type: "poll", question: "Q", options: ["x", "y"] };

const CAN_EDIT: Record<Role, boolean> = { owner: true, admin: true, editor: true, moderator: false, viewer: false };
const CAN_LIVE: Record<Role, boolean> = { owner: true, admin: true, editor: true, moderator: true, viewer: false };
const status = (allowed: boolean, ok: number) => (allowed ? ok : 403);

test("unauthenticated calls return 401 with an error", async () => {
  const res = await listRoute.POST(req(null, eventBody));
  expect(res.status).toBe(401);
  expect(((await res.json()) as { error: string }).error).toBeTruthy();
  expect((await startRoute.POST(req(null), itCtx())).status).toBe(401);
});

for (const role of ROLES) {
  test(`${role}: create and edit`, async () => {
    const create = await listRoute.POST(req(userIds[role], eventBody));
    expect(create.status).toBe(status(CAN_EDIT[role], 201));
    if (!CAN_EDIT[role]) expect(((await create.json()) as { error: string }).error).toBeTruthy();
    else expect(((await create.json()) as { event: { createdBy: string } }).event.createdBy).toBe(userIds[role]);

    const patch = await eventRoute.PATCH(
      new Request("http://localhost/x", {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed" }),
        headers: { cookie: `${session.SESSION_COOKIE}=${session.createSessionToken(userIds[role])}; workspace=${workspaceId}` },
      }),
      evCtx(),
    );
    expect(patch.status).toBe(status(CAN_EDIT[role], 200));

    const add = await interactionsRoute.POST(req(userIds[role], pollBody), evCtx());
    expect(add.status).toBe(status(CAN_EDIT[role], 201));
  });

  test(`${role}: run live`, async () => {
    const res = await startRoute.POST(req(userIds[role]), itCtx());
    expect(res.status).toBe(status(CAN_LIVE[role], 200));
  });

  test(`${role}: delete an event and an interaction created by someone else`, async () => {
    const allowed = role === "owner" || role === "admin";
    const del = (userId: string) =>
      new Request("http://localhost/x", {
        method: "DELETE",
        headers: { cookie: `${session.SESSION_COOKIE}=${session.createSessionToken(userId)}; workspace=${workspaceId}` },
      });
    expect((await interactionRoute.DELETE(del(userIds[role]), itCtx())).status).toBe(status(allowed, 204));
    expect((await eventRoute.DELETE(del(userIds[role]), evCtx())).status).toBe(status(allowed, 204));
  });
}

test("an editor can delete content they created", async () => {
  await seed(userIds.editor);
  const del = new Request("http://localhost/x", {
    method: "DELETE",
    headers: { cookie: `${session.SESSION_COOKIE}=${session.createSessionToken(userIds.editor)}; workspace=${workspaceId}` },
  });
  expect((await interactionRoute.DELETE(del, itCtx())).status).toBe(204);
  expect((await eventRoute.DELETE(del, evCtx())).status).toBe(204);
});
