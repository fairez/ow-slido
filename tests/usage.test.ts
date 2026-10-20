// @vitest-environment node
import { afterAll, beforeEach, expect, test } from "vitest";
import { aiCalls, authTokens, events, invitations, participants, users } from "@/db/schema";
import { getUsage } from "@/lib/usage";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();
beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

const NOW = new Date("2026-10-20T12:00:00Z");
let codes = 0;

async function workspace(email: string) {
  const [user] = await db.insert(users).values({ email, passwordHash: "x" }).returning();
  const ws = await createPersonalWorkspace(db, user);
  const makeEvent = async (createdAt: Date) => {
    const [event] = await db
      .insert(events)
      .values({
        workspaceId: ws.id,
        ownerId: user.id,
        createdBy: user.id,
        name: "Event",
        joinCode: String(300000 + codes++),
        startsAt: createdAt,
        endsAt: new Date(createdAt.getTime() + 3_600_000),
        createdAt,
      })
      .returning();
    return event;
  };
  return { user, workspaceId: ws.id, makeEvent };
}

test("a fresh workspace has used one seat and nothing else", async () => {
  const a = await workspace("a@example.com");
  expect(await getUsage(a.workspaceId, { db, now: NOW })).toEqual({
    seats: 1,
    eventsThisMonth: 0,
    participantsPeak: 0,
    aiCallsThisMonth: 0,
    storageMb: 0,
  });
});

test("counts this month's events, the busiest audience and AI calls, ignoring last month and other workspaces", async () => {
  const a = await workspace("a@example.com");
  const b = await workspace("b@example.com");
  const busy = await a.makeEvent(new Date("2026-10-02T10:00:00Z"));
  const quiet = await a.makeEvent(new Date("2026-10-15T10:00:00Z"));
  const old = await a.makeEvent(new Date("2026-09-30T23:59:00Z"));
  const other = await b.makeEvent(new Date("2026-10-10T10:00:00Z"));

  const some = (eventId: string, n: number) => Array.from({ length: n }, () => ({ eventId }));
  await db.insert(participants).values([...some(busy.id, 5), ...some(quiet.id, 2), ...some(old.id, 40), ...some(other.id, 9)]);
  const call = (eventId: string, createdAt: Date) => ({ eventId, kind: "analysis", provider: "mock", model: "m", createdAt });
  await db.insert(aiCalls).values([
    call(busy.id, new Date("2026-10-03T10:00:00Z")),
    call(quiet.id, new Date("2026-10-04T10:00:00Z")),
    call(old.id, new Date("2026-09-30T10:00:00Z")),
    call(other.id, new Date("2026-10-05T10:00:00Z")),
  ]);

  const usage = await getUsage(a.workspaceId, { db, now: NOW });
  expect(usage.eventsThisMonth).toBe(2);
  expect(usage.participantsPeak).toBe(5);
  expect(usage.aiCallsThisMonth).toBe(2);
});

test("seats count active members and unexpired pending invitations only", async () => {
  const a = await workspace("a@example.com");
  const invite = async (email: string, expiresAt: Date) => {
    const [token] = await db
      .insert(authTokens)
      .values({ purpose: "invite", tokenHash: `hash-${email}`, expiresAt })
      .returning();
    await db
      .insert(invitations)
      .values({ workspaceId: a.workspaceId, email, role: "viewer", invitedBy: a.user.id, tokenId: token.id, expiresAt });
  };
  await invite("pending@example.com", new Date(Date.now() + 86_400_000));
  await invite("expired@example.com", new Date(Date.now() - 86_400_000));
  expect((await getUsage(a.workspaceId, { db })).seats).toBe(2);
});
