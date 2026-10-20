// @vitest-environment node
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { events, invitations, memberships, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { PLANS, type GatedInteractionType } from "@/lib/plans";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request, ctx?: never) => Promise<Response>;
type Ctx<T> = { params: Promise<T> };
let createEvent: Handler;
let duplicateEvent: (req: Request, ctx: Ctx<{ id: string }>) => Promise<Response>;
let createInteraction: (req: Request, ctx: Ctx<{ id: string }>) => Promise<Response>;
let duplicateInteraction: (req: Request, ctx: Ctx<{ id: string; interactionId: string }>) => Promise<Response>;
let createInvite: Handler;
let acceptInvite: Handler;
let patchMember: (req: Request, ctx: Ctx<{ userId: string }>) => Promise<Response>;
let session: typeof import("@/lib/auth/session");
const passwordHash = hashPassword("correct horse battery");

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  createEvent = (await import("@/app/api/events/route")).POST;
  duplicateEvent = (await import("@/app/api/events/[id]/duplicate/route")).POST;
  createInteraction = (await import("@/app/api/events/[id]/interactions/route")).POST;
  duplicateInteraction = (await import("@/app/api/events/[id]/interactions/[interactionId]/duplicate/route")).POST;
  createInvite = (await import("@/app/api/invitations/route")).POST;
  acceptInvite = (await import("@/app/api/invitations/accept/route")).POST;
  patchMember = (await import("@/app/api/members/[userId]/route")).PATCH;
  session = await import("@/lib/auth/session");
});
beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

const req = (method: string, path: string, body?: unknown, cookie?: string) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-real-ip": "10.0.0.1", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function makeUser(email: string) {
  const [user] = await db.insert(users).values({ email, passwordHash: await passwordHash }).returning();
  const workspace = await createPersonalWorkspace(db, user);
  return { user, workspaceId: workspace.id, cookie: `session=${session.createSessionToken(user.id)}` };
}

const newEvent = (cookie: string, name = "Town hall") =>
  createEvent(
    req("POST", "/api/events", { name, startsAt: "2030-01-01T10:00:00Z", endsAt: "2030-01-01T12:00:00Z" }, cookie),
  );
const newPoll = (cookie: string, eventId: string) =>
  createInteraction(
    req("POST", `/api/events/${eventId}/interactions`, { type: "poll", question: "Lunch?", options: ["Rice", "Noodles"] }, cookie),
    { params: Promise.resolve({ id: eventId }) },
  );
const invite = (cookie: string, email: string) => createInvite(req("POST", "/api/invitations", { email, role: "editor" }, cookie));

// --- interaction types ---

const free = PLANS.free as { allowedTypes: readonly GatedInteractionType[] };
const originalTypes = free.allowedTypes;
afterEach(() => {
  free.allowedTypes = originalTypes;
});

test("a type in allowedTypes can be created and duplicated", async () => {
  const owner = await makeUser("owner@example.com");
  const event = await (await newEvent(owner.cookie)).json();
  const created = await newPoll(owner.cookie, event.event.id);
  expect(created.status).toBe(201);
  const { interaction } = await created.json();
  const copy = await duplicateInteraction(
    req("POST", "/x", undefined, owner.cookie),
    { params: Promise.resolve({ id: event.event.id, interactionId: interaction.id }) },
  );
  expect(copy.status).toBe(201);
});

test("a type outside allowedTypes is refused with 402 and the plan that has it", async () => {
  const owner = await makeUser("owner@example.com");
  const event = (await (await newEvent(owner.cookie)).json()).event;
  const { interaction } = await (await newPoll(owner.cookie, event.id)).json();

  free.allowedTypes = ["wordcloud"];
  const denied = await newPoll(owner.cookie, event.id);
  expect(denied.status).toBe(402);
  const body = await denied.json();
  expect(body).toMatchObject({ reason: "type_not_allowed", requiredPlan: "pro" });
  expect(typeof body.error).toBe("string");

  const copy = await duplicateInteraction(
    req("POST", "/x", undefined, owner.cookie),
    { params: Promise.resolve({ id: event.id, interactionId: interaction.id }) },
  );
  // Content already in the workspace is kept read-only rather than sold as a new limit (see downgrade.test.ts).
  expect(copy.status).toBe(403);
  expect(await copy.json()).toMatchObject({ reason: "over_limit", requiredPlan: "pro" });

  await setPlan(db, owner.workspaceId, "pro");
  expect((await newPoll(owner.cookie, event.id)).status).toBe(201);
});

// --- events per month ---

test("the fourth event of the month on Free is refused; Pro is not limited", async () => {
  const owner = await makeUser("owner@example.com");
  for (let i = 0; i < PLANS.free.eventsPerMonth!; i++) expect((await newEvent(owner.cookie, `E${i}`)).status).toBe(201);

  const denied = await newEvent(owner.cookie, "One too many");
  expect(denied.status).toBe(402);
  expect(await denied.json()).toMatchObject({ reason: "event_limit", requiredPlan: "pro" });

  const [first] = await db.select().from(events).where(eq(events.workspaceId, owner.workspaceId));
  const dup = await duplicateEvent(req("POST", "/x", undefined, owner.cookie), { params: Promise.resolve({ id: first.id }) });
  expect(dup.status).toBe(402);
  expect((await dup.json()).reason).toBe("event_limit");

  await setPlan(db, owner.workspaceId, "pro");
  expect((await newEvent(owner.cookie, "Now fine")).status).toBe(201);
});

test("events created in an earlier month do not count", async () => {
  const owner = await makeUser("owner@example.com");
  const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15));
  for (let i = 0; i < 5; i++) {
    await db.insert(events).values({
      ownerId: owner.user.id,
      createdBy: owner.user.id,
      workspaceId: owner.workspaceId,
      name: `Old ${i}`,
      startsAt: lastMonth,
      endsAt: lastMonth,
      joinCode: `99900${i}`,
      createdAt: lastMonth,
    });
  }
  expect((await newEvent(owner.cookie)).status).toBe(201);
});

test("another workspace's events do not count against this one", async () => {
  const a = await makeUser("a@example.com");
  const b = await makeUser("b@example.com");
  for (let i = 0; i < 3; i++) await newEvent(a.cookie, `A${i}`);
  expect((await newEvent(a.cookie)).status).toBe(402);
  expect((await newEvent(b.cookie)).status).toBe(201);
});

// --- seats ---

test("Free has one seat, so the owner cannot invite; Pro allows up to three with pending ones counted", async () => {
  const owner = await makeUser("owner@example.com");
  const denied = await invite(owner.cookie, "one@example.com");
  expect(denied.status).toBe(402);
  expect(await denied.json()).toMatchObject({ reason: "seat_limit", requiredPlan: "pro" });
  expect(await db.select().from(invitations)).toHaveLength(0);

  await setPlan(db, owner.workspaceId, "pro");
  expect((await invite(owner.cookie, "one@example.com")).status).toBe(201);
  expect((await invite(owner.cookie, "two@example.com")).status).toBe(201);
  const full = await invite(owner.cookie, "three@example.com");
  expect(full.status).toBe(402);
  expect(await full.json()).toMatchObject({ reason: "seat_limit", requiredPlan: "team" });
});

test("a suspended member and an expired invitation do not hold a seat", async () => {
  const owner = await makeUser("owner@example.com");
  await setPlan(db, owner.workspaceId, "pro");
  const other = await makeUser("other@example.com");
  await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: other.user.id, role: "editor", status: "suspended" });
  expect((await invite(owner.cookie, "one@example.com")).status).toBe(201);
  expect((await invite(owner.cookie, "two@example.com")).status).toBe(201);
  expect((await invite(owner.cookie, "three@example.com")).status).toBe(402);

  await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.email, "two@example.com"));
  expect((await invite(owner.cookie, "three@example.com")).status).toBe(201);
});

test("accepting is refused once the plan no longer has the seat, and allowed while it does", async () => {
  const owner = await makeUser("owner@example.com");
  await setPlan(db, owner.workspaceId, "pro");
  const link = async (email: string) => {
    const body = await (await invite(owner.cookie, email)).json();
    return new URL(body.link).searchParams.get("token")!;
  };
  const first = await link("one@example.com");
  const second = await link("two@example.com");

  const ok = await acceptInvite(req("POST", "/api/invitations/accept", { token: first, password: "correct horse battery" }));
  expect(ok.status).toBe(200);

  await setPlan(db, owner.workspaceId, "free");
  const denied = await acceptInvite(req("POST", "/api/invitations/accept", { token: second, password: "correct horse battery" }));
  expect(denied.status).toBe(402);
  expect(await denied.json()).toMatchObject({ reason: "seat_limit", requiredPlan: "pro" });
  const [pending] = await db.select().from(invitations).where(eq(invitations.email, "two@example.com"));
  expect(pending.status).toBe("pending");
  expect(await db.select().from(users).where(eq(users.email, "two@example.com"))).toHaveLength(0);
});

test("reactivating a member needs a free seat", async () => {
  const owner = await makeUser("owner@example.com");
  const member = await makeUser("member@example.com");
  await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: member.user.id, role: "editor", status: "suspended" });
  const reactivate = () =>
    patchMember(req("PATCH", `/api/members/${member.user.id}`, { status: "active" }, owner.cookie), {
      params: Promise.resolve({ userId: member.user.id }),
    });

  const denied = await reactivate();
  expect(denied.status).toBe(402);
  expect((await denied.json()).reason).toBe("seat_limit");

  await setPlan(db, owner.workspaceId, "pro");
  expect((await reactivate()).status).toBe(200);
  const [row] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, owner.workspaceId), eq(memberships.userId, member.user.id)));
  expect(row.status).toBe("active");
});
