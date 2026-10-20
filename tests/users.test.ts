// @vitest-environment node
import { afterAll, beforeEach, expect, test } from "vitest";
import { users } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

test("inserts a user with defaults", async () => {
  const [u] = await db.insert(users).values({ email: "a@b.co", passwordHash: "h" }).returning();
  expect(u.active).toBe(true);
  expect(u.createdAt).toBeInstanceOf(Date);
});

test("rejects duplicate, and uppercase email", async () => {
  await db.insert(users).values({ email: "a@b.co", passwordHash: "h" });
  await expect(db.insert(users).values({ email: "a@b.co", passwordHash: "h" })).rejects.toThrow();
  await expect(db.insert(users).values({ email: "A@b.co", passwordHash: "h" })).rejects.toThrow();
});
