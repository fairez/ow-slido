// @vitest-environment node
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { authTokens, interactions, invitations, memberships, subscriptions, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { expireSubscriptions } from "@/lib/billing/expire";
import { applyBillingEvent } from "@/lib/billing/webhook";
import type { BillingEvent } from "@/lib/billing/types";
import { removeMember } from "@/lib/members";
import { PLANS, type GatedInteractionType } from "@/lib/plans";
import { reconcileSeats } from "@/lib/seats";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx<T> = { params: Promise<T> };
type Route<T> = (req: Request, ctx: Ctx<T>) => Promise<Response>;
let createEvent: (req: Request) => Promise<Response>;
let patchEvent: Route<{ id: string }>;
let duplicateEvent: Route<{ id: string }>;
let exportCsv: Route<{ id: string }>;
let createInteraction: Route<{ id: string }>;
let reorder: Route<{ id: string }>;
let patchInteraction: Route<{ id: string; interactionId: string }>;
let deleteInteraction: Route<{ id: string; interactionId: string }>;
let duplicateInteraction: Route<{ id: string; interactionId: string }>;
let startInteraction: Route<{ id: string; interactionId: string }>;
let closeInteraction: Route<{ id: string; interactionId: string }>;
let listMembersRoute: (req: Request) => Promise<Response>;
let publisher: typeof import("@/lib/realtime/publisher");
let session: typeof import("@/lib/auth/session");
const passwordHash = hashPassword("correct horse battery");

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  createEvent = (await import("@/app/api/events/route")).POST;
  patchEvent = (await import("@/app/api/events/[id]/route")).PATCH;
  duplicateEvent = (await import("@/app/api/events/[id]/duplicate/route")).POST;
  exportCsv = (await import("@/app/api/events/[id]/export.csv/route")).GET;
  createInteraction = (await import("@/app/api/events/[id]/interactions/route")).POST;
  reorder = (await import("@/app/api/events/[id]/interactions/reorder/route")).POST;
  patchInteraction = (await import("@/app/api/events/[id]/interactions/[interactionId]/route")).PATCH;
  deleteInteraction = (await import("@/app/api/events/[id]/interactions/[interactionId]/route")).DELETE;
  duplicateInteraction = (await import("@/app/api/events/[id]/interactions/[interactionId]/duplicate/route")).POST;
  startInteraction = (await import("@/app/api/events/[id]/interactions/[interactionId]/start/route")).POST;
  closeInteraction = (await import("@/app/api/events/[id]/interactions/[interactionId]/close/route")).POST;
  listMembersRoute = (await import("@/app/api/members/route")).GET;
  publisher = await import("@/lib/realtime/publisher");
  session = await import("@/lib/auth/session");
});

let revoked: string[] = [];
beforeEach(async () => {
  await truncateAll(db);
  revoked = [];
  publisher.setMemberRevoker((userId) => revoked.push(userId));
});
afterAll(() => {
  publisher.setMemberRevoker(null);
  return pool.end();
});

// Free's types are all of today's types, so a test narrows them to stand in for "Pro-only content".
const free = PLANS.free as { allowedTypes: readonly GatedInteractionType[] };
const originalTypes = free.allowedTypes;
afterEach(() => {
  free.allowedTypes = originalTypes;
});

const req = (method: string, path: string, body?: unknown, cookie?: string) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-real-ip": "10.0.0.1", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function makeOwner(email = "owner@example.com") {
  const [user] = await db.insert(users).values({ email, passwordHash: await passwordHash, emailVerifiedAt: new Date() }).returning();
  const workspace = await createPersonalWorkspace(db, user);
  return { user, workspaceId: workspace.id, cookie: `session=${session.createSessionToken(user.id)}` };
}

let joined = 0;
/** A member of `workspaceId`; `joined` orders them (later is newer) regardless of how fast the test runs. */
async function addMember(workspaceId: string, email: string, role: "owner" | "admin" | "editor" = "editor", status: "active" | "suspended" = "active") {
  const [user] = await db.insert(users).values({ email, passwordHash: await passwordHash }).returning();
  await db.insert(memberships).values({ workspaceId, userId: user.id, role, status, createdAt: new Date(Date.UTC(2031, 0, 1, 0, 0, ++joined)) });
  return user;
}

const ev = (id: string) => ({ params: Promise.resolve({ id }) });
const iv = (id: string, interactionId: string) => ({ params: Promise.resolve({ id, interactionId }) });

async function newEvent(cookie: string, name: string) {
  const response = await createEvent(
    req("POST", "/api/events", { name, startsAt: "2030-01-01T10:00:00Z", endsAt: "2030-01-01T12:00:00Z" }, cookie),
  );
  expect(response.status).toBe(201);
  return (await response.json()).event as { id: string };
}
async function newPoll(cookie: string, eventId: string) {
  const response = await createInteraction(
    req("POST", `/api/events/${eventId}/interactions`, { type: "poll", question: "Lunch?", options: ["Rice", "Noodles"] }, cookie),
    ev(eventId),
  );
  expect(response.status).toBe(201);
  return (await response.json()).interaction as { id: string };
}

describe("content a downgrade leaves behind", () => {
  test("an interaction whose type the plan dropped keeps its results but cannot be started, edited or duplicated", async () => {
    const owner = await makeOwner();
    await setPlan(db, owner.workspaceId, "pro");
    const event = await newEvent(owner.cookie, "Town hall");
    const draft = await newPoll(owner.cookie, event.id);
    const live = await newPoll(owner.cookie, event.id);
    expect((await startInteraction(req("POST", "/x", undefined, owner.cookie), iv(event.id, live.id))).status).toBe(200);

    free.allowedTypes = ["wordcloud"];
    await setPlan(db, owner.workspaceId, "free");

    for (const attempt of [
      () => startInteraction(req("POST", "/x", undefined, owner.cookie), iv(event.id, draft.id)),
      () => patchInteraction(req("PATCH", "/x", { question: "Dinner?", options: ["A", "B"] }, owner.cookie), iv(event.id, draft.id)),
      () => duplicateInteraction(req("POST", "/x", undefined, owner.cookie), iv(event.id, draft.id)),
    ]) {
      const denied = await attempt();
      expect(denied.status).toBe(403);
      const body = await denied.json();
      expect(body).toMatchObject({ reason: "over_limit", requiredPlan: "pro" });
      expect(typeof body.error).toBe("string");
    }

    // Results and export stay, and a live interaction can still be closed and deleted.
    expect((await exportCsv(req("GET", "/x", undefined, owner.cookie), ev(event.id))).status).toBe(200);
    expect((await closeInteraction(req("POST", "/x", undefined, owner.cookie), iv(event.id, live.id))).status).toBe(200);
    expect((await deleteInteraction(req("DELETE", "/x", undefined, owner.cookie), iv(event.id, draft.id))).status).toBe(204);
  });

  test("upgrading back restores everything", async () => {
    const owner = await makeOwner();
    await setPlan(db, owner.workspaceId, "pro");
    const event = await newEvent(owner.cookie, "Town hall");
    const draft = await newPoll(owner.cookie, event.id);

    free.allowedTypes = ["wordcloud"];
    await setPlan(db, owner.workspaceId, "free");
    expect((await startInteraction(req("POST", "/x", undefined, owner.cookie), iv(event.id, draft.id))).status).toBe(403);

    await setPlan(db, owner.workspaceId, "pro");
    expect((await duplicateInteraction(req("POST", "/x", undefined, owner.cookie), iv(event.id, draft.id))).status).toBe(201);
    expect(
      (await patchInteraction(req("PATCH", "/x", { question: "Dinner?", options: ["A", "B"] }, owner.cookie), iv(event.id, draft.id))).status,
    ).toBe(200);
    expect((await startInteraction(req("POST", "/x", undefined, owner.cookie), iv(event.id, draft.id))).status).toBe(200);
  });

  test("events past the monthly cap are read-only; the first ones stay editable", async () => {
    const owner = await makeOwner();
    await setPlan(db, owner.workspaceId, "pro");
    const created: { id: string }[] = [];
    for (let i = 0; i < PLANS.free.eventsPerMonth! + 2; i++) created.push(await newEvent(owner.cookie, `Event ${i}`));
    const poll = await newPoll(owner.cookie, created[4].id);
    await setPlan(db, owner.workspaceId, "free");

    const rename = (id: string) => patchEvent(req("PATCH", "/x", { name: "Renamed" }, owner.cookie), ev(id));
    for (const kept of created.slice(0, 3)) expect((await rename(kept.id)).status).toBe(200);

    for (const over of created.slice(3)) {
      const denied = await rename(over.id);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ reason: "over_limit", requiredPlan: "pro" });
    }
    const last = created[4].id;
    expect((await duplicateEvent(req("POST", "/x", undefined, owner.cookie), ev(last))).status).toBe(403);
    expect((await startInteraction(req("POST", "/x", undefined, owner.cookie), iv(last, poll.id))).status).toBe(403);
    expect((await patchInteraction(req("PATCH", "/x", { question: "Dinner?", options: ["A", "B"] }, owner.cookie), iv(last, poll.id))).status).toBe(403);
    expect(
      (await createInteraction(req("POST", "/x", { type: "poll", question: "More?", options: ["A", "B"] }, owner.cookie), ev(last))).status,
    ).toBe(403);
    expect((await reorder(req("POST", "/x", { ids: [poll.id] }, owner.cookie), ev(last))).status).toBe(403);
    expect((await exportCsv(req("GET", "/x", undefined, owner.cookie), ev(last))).status).toBe(200);

    await setPlan(db, owner.workspaceId, "pro");
    expect((await rename(last)).status).toBe(200);
    expect((await startInteraction(req("POST", "/x", undefined, owner.cookie), iv(last, poll.id))).status).toBe(200);
  });

  test("an event copy leaves out types the plan dropped", async () => {
    const owner = await makeOwner();
    await setPlan(db, owner.workspaceId, "pro");
    const event = await newEvent(owner.cookie, "Source");
    await newPoll(owner.cookie, event.id);
    await createInteraction(
      req("POST", "/x", { type: "wordcloud", prompt: "One word", maxEntriesPerParticipant: 2 }, owner.cookie),
      ev(event.id),
    );

    free.allowedTypes = ["wordcloud"];
    await setPlan(db, owner.workspaceId, "free");
    const copy = await duplicateEvent(req("POST", "/x", undefined, owner.cookie), ev(event.id));
    expect(copy.status).toBe(201);
    const copied = await db.select().from(interactions).where(eq(interactions.eventId, (await copy.json()).event.id));
    expect(copied.map((i) => i.type)).toEqual(["wordcloud"]);
  });
});

describe("members beyond the seat limit", () => {
  const states = async (workspaceId: string) =>
    Object.fromEntries(
      (
        await db
          .select({ email: users.email, status: memberships.status, reason: memberships.suspendedReason })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(eq(memberships.workspaceId, workspaceId))
      ).map((m) => [m.email.split("@")[0], m.reason ? `${m.status}:${m.reason}` : m.status]),
    );

  test("the newest are suspended with a reason and come back on upgrade, oldest first", async () => {
    const owner = await makeOwner();
    await setPlan(db, owner.workspaceId, "team");
    await addMember(owner.workspaceId, "ann@example.com");
    await addMember(owner.workspaceId, "bob@example.com");
    await addMember(owner.workspaceId, "cy@example.com");

    await setPlan(db, owner.workspaceId, "free");
    const result = await reconcileSeats(owner.workspaceId, { db });
    expect(result.suspended).toHaveLength(3);
    expect(await states(owner.workspaceId)).toEqual({
      owner: "active",
      ann: "suspended:seat_limit",
      bob: "suspended:seat_limit",
      cy: "suspended:seat_limit",
    });
    expect(revoked).toHaveLength(3);

    // Pro has 3 seats: the owner plus the two longest-standing members return; the newest waits.
    await setPlan(db, owner.workspaceId, "pro");
    await reconcileSeats(owner.workspaceId, { db });
    expect(await states(owner.workspaceId)).toEqual({ owner: "active", ann: "active", bob: "active", cy: "suspended:seat_limit" });

    await setPlan(db, owner.workspaceId, "team");
    await reconcileSeats(owner.workspaceId, { db });
    expect(await states(owner.workspaceId)).toEqual({ owner: "active", ann: "active", bob: "active", cy: "active" });
  });

  test("the last active owner is never suspended, even when they joined last", async () => {
    const owner = await makeOwner();
    // Make the workspace creator the newest membership.
    await db.update(memberships).set({ createdAt: new Date(Date.UTC(2032, 0, 1)) }).where(eq(memberships.workspaceId, owner.workspaceId));
    await addMember(owner.workspaceId, "ann@example.com", "admin");
    await addMember(owner.workspaceId, "bob@example.com");

    await reconcileSeats(owner.workspaceId, { db });
    expect(await states(owner.workspaceId)).toEqual({ owner: "active", ann: "suspended:seat_limit", bob: "suspended:seat_limit" });
  });

  test("a second owner can be suspended while one stays", async () => {
    const owner = await makeOwner();
    await addMember(owner.workspaceId, "co@example.com", "owner");
    await reconcileSeats(owner.workspaceId, { db });
    expect(await states(owner.workspaceId)).toEqual({ owner: "active", co: "suspended:seat_limit" });
  });

  test("a manual suspension is not lifted when seats free up", async () => {
    const owner = await makeOwner();
    await setPlan(db, owner.workspaceId, "team");
    await addMember(owner.workspaceId, "ann@example.com", "editor", "suspended");
    await reconcileSeats(owner.workspaceId, { db });
    expect((await states(owner.workspaceId)).ann).toBe("suspended");
  });

  test("pending invitations hold their seats before anyone comes back", async () => {
    const owner = await makeOwner();
    await setPlan(db, owner.workspaceId, "pro");
    const ann = await addMember(owner.workspaceId, "ann@example.com", "editor", "suspended");
    const bob = await addMember(owner.workspaceId, "bob@example.com", "editor", "suspended");
    await db.update(memberships).set({ suspendedReason: "seat_limit" }).where(inArray(memberships.userId, [ann.id, bob.id]));
    await db.insert(invitations).values({
      workspaceId: owner.workspaceId,
      email: "new@example.com",
      role: "editor",
      invitedBy: owner.user.id,
      tokenId: await tokenFor(owner.user.id),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    // Pro has 3 seats: the owner and the invitation hold two, so only the longest-standing member returns.
    await reconcileSeats(owner.workspaceId, { db });
    expect(await states(owner.workspaceId)).toEqual({ owner: "active", ann: "active", bob: "suspended:seat_limit" });
  });

  test("removing a member frees a seat for someone the plan suspended", async () => {
    const owner = await makeOwner();
    await setPlan(db, owner.workspaceId, "team");
    const ann = await addMember(owner.workspaceId, "ann@example.com");
    await addMember(owner.workspaceId, "bob@example.com");
    await addMember(owner.workspaceId, "cy@example.com");
    await setPlan(db, owner.workspaceId, "pro");
    await reconcileSeats(owner.workspaceId, { db });
    expect((await states(owner.workspaceId)).cy).toBe("suspended:seat_limit");

    expect((await removeMember(db, owner.workspaceId, { userId: owner.user.id, role: "owner" }, ann.id)).ok).toBe(true);
    expect(await states(owner.workspaceId)).toEqual({ owner: "active", bob: "active", cy: "active" });
  });

  test("the members list catches up a plan change nobody has applied yet", async () => {
    const owner = await makeOwner();
    await setPlan(db, owner.workspaceId, "team");
    await addMember(owner.workspaceId, "ann@example.com");
    await setPlan(db, owner.workspaceId, "free");

    const response = await listMembersRoute(req("GET", "/api/members", undefined, owner.cookie));
    const { members } = await response.json();
    expect(members.find((m: { email: string }) => m.email === "ann@example.com")).toMatchObject({
      status: "suspended",
      suspendedReason: "seat_limit",
    });
  });

  test("a downgrade webhook suspends and a later upgrade webhook restores", async () => {
    const owner = await makeOwner();
    await addMember(owner.workspaceId, "ann@example.com");
    await addMember(owner.workspaceId, "bob@example.com");
    const now = new Date("2031-06-01T00:00:00Z");
    const event = (over: Partial<BillingEvent>): BillingEvent => ({
      id: `evt_${Math.random()}`,
      type: "test",
      workspaceId: owner.workspaceId,
      plan: "team",
      interval: "month",
      status: "active",
      currentPeriodEnd: new Date("2031-07-01T00:00:00Z"),
      providerCustomerId: "cus_1",
      providerSubscriptionId: "sub_1",
      ...over,
    });

    await applyBillingEvent("mock", event({}), db, now);
    expect(await states(owner.workspaceId)).toEqual({ owner: "active", ann: "active", bob: "active" });

    // Canceled with the period already over: Free from now on.
    await applyBillingEvent("mock", event({ status: "canceled", currentPeriodEnd: new Date("2031-05-31T00:00:00Z") }), db, now);
    expect(await states(owner.workspaceId)).toEqual({ owner: "active", ann: "suspended:seat_limit", bob: "suspended:seat_limit" });

    await applyBillingEvent("mock", event({}), db, now);
    expect(await states(owner.workspaceId)).toEqual({ owner: "active", ann: "active", bob: "active" });
  });

  test("the sweep reconciles workspaces whose paid access just ended", async () => {
    const owner = await makeOwner();
    await addMember(owner.workspaceId, "ann@example.com");
    await db.insert(subscriptions).values({
      workspaceId: owner.workspaceId,
      plan: "team",
      status: "canceled",
      currentPeriodEnd: new Date("2031-05-31T00:00:00Z"),
    });
    const lapsed = await expireSubscriptions(db, new Date("2031-06-01T00:00:00Z"));
    expect(lapsed).toEqual([owner.workspaceId]);
    await reconcileSeats(lapsed[0], { db, now: new Date("2031-06-01T00:00:00Z") });
    expect((await states(owner.workspaceId)).ann).toBe("suspended:seat_limit");
  });
});

async function tokenFor(userId: string) {
  const [token] = await db
    .insert(authTokens)
    .values({ userId, purpose: "invite", tokenHash: `h-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: authTokens.id });
  return token.id;
}
