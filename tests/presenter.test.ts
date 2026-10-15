// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, users } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();
let getPresenterState: typeof import("@/lib/presenter").getPresenterState;
let eventId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  getPresenterState = (await import("@/lib/presenter")).getPresenterState;
});

beforeEach(async () => {
  await truncateAll(db);
  const [user] = await db.insert(users).values({ email: "host@example.com", passwordHash: "x" }).returning();
  const [event] = await db
    .insert(events)
    .values({
      ownerId: user.id,
      name: "Town hall",
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T11:00:00Z"),
      joinCode: "123456",
    })
    .returning();
  eventId = event.id;
});
afterAll(() => pool.end());

const config = { options: [{ id: "a", label: "Pizza" }, { id: "b", label: "Tacos" }], multiSelect: false, showResultsToParticipants: false };

test("null when nothing is live", async () => {
  await db.insert(interactions).values({ eventId, type: "poll", title: "Q", position: 0, state: "draft", config });
  expect(await getPresenterState(eventId)).toBeNull();
});

test("returns the live poll with zeroed counts", async () => {
  const [row] = await db.insert(interactions).values({ eventId, type: "poll", title: "Q", position: 0, state: "live", config }).returning();
  expect(await getPresenterState(eventId)).toMatchObject({ id: row.id, title: "Q", counts: { a: 0, b: 0 }, total: 0 });
});
