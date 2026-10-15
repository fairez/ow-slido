// @vitest-environment node
import { afterAll, beforeEach, expect, test } from "vitest";
import { appMeta } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

test("migrated schema is usable and truncation clears rows", async () => {
  await db.insert(appMeta).values({ key: "k", value: "v" });
  expect(await db.select().from(appMeta)).toHaveLength(1);
  await truncateAll(db);
  expect(await db.select().from(appMeta)).toHaveLength(0);
});
