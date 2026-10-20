// @vitest-environment node
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "./helpers/db";

const { pool } = createTestDb();

let join: (req: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  join = (await import("@/app/api/join/route")).POST;
});
afterAll(() => pool.end());

function joinRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/join", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ code: "000000" }),
  });
}

test("an unknown join code returns the English message by default", async () => {
  const res = await join(joinRequest());
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Event not found" });
});

test("the lang=id cookie switches the error message, not the status or shape", async () => {
  const res = await join(joinRequest({ cookie: "lang=id" }));
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Acara tidak ditemukan" });
});
