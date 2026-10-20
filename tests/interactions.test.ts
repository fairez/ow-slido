// @vitest-environment node
import { afterAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, users } from "@/db/schema";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

async function makeEvent(joinCode = "123456") {
  const [u] = await db
    .insert(users)
    .values({ email: `${joinCode}@b.co`, passwordHash: "h" })
    .returning();
  const [e] = await db
    .insert(events)
    .values({
      workspaceId: await workspaceFor(db, u.id), ownerId: u.id,
      name: "E",
      startsAt: new Date("2026-01-01"),
      endsAt: new Date("2026-01-02"),
      joinCode,
    })
    .returning();
  return e;
}

test("inserts an interaction with defaults", async () => {
  const e = await makeEvent();
  const [i] = await db
    .insert(interactions)
    .values({ eventId: e.id, type: "poll", title: "Q?", position: 0 })
    .returning();
  expect(i.state).toBe("draft");
  expect(i.config).toEqual({});
  expect(i.createdAt).toBeInstanceOf(Date);
});

test("rejects unknown type and state", async () => {
  const e = await makeEvent();
  await expect(
    db.insert(interactions).values({ eventId: e.id, type: "qa" as "poll", title: "t", position: 0 }),
  ).rejects.toThrow();
  await expect(
    db
      .insert(interactions)
      .values({ eventId: e.id, type: "poll", title: "t", position: 0, state: "x" as "draft" }),
  ).rejects.toThrow();
});

test("allows at most one live interaction per event", async () => {
  const e = await makeEvent();
  const other = await makeEvent("654321");
  await db
    .insert(interactions)
    .values({ eventId: e.id, type: "poll", title: "a", position: 0, state: "live" });
  await expect(
    db
      .insert(interactions)
      .values({ eventId: e.id, type: "wordcloud", title: "b", position: 1, state: "live" }),
  ).rejects.toThrow();
  await db
    .insert(interactions)
    .values({ eventId: e.id, type: "poll", title: "c", position: 2, state: "closed" });
  await db
    .insert(interactions)
    .values({ eventId: other.id, type: "poll", title: "d", position: 0, state: "live" });
});

test("deleting the event cascades to interactions", async () => {
  const e = await makeEvent();
  await db.insert(interactions).values({ eventId: e.id, type: "poll", title: "a", position: 0 });
  await db.delete(events).where(eq(events.id, e.id));
  expect(await db.select().from(interactions)).toHaveLength(0);
});
