// @vitest-environment node
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "./helpers/db";

const { pool } = createTestDb();
let health: typeof import("@/app/api/health/route");

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  health = await import("@/app/api/health/route");
});
afterAll(() => pool.end());

test("health reports ok without authentication when the database answers", async () => {
  const res = await health.GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});
