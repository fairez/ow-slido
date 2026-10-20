// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { users } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const cookieValue = vi.fn<() => string | undefined>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookieValue() ? { value: cookieValue() } : undefined) }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

describe("dashboard guard", () => {
  const { db, pool } = createTestDb();
  let DashboardPage: typeof import("@/app/dashboard/page").default;
  let sessionToken: typeof import("@/lib/auth/session").createSessionToken;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.SESSION_SECRET ||= "test-secret";
    DashboardPage = (await import("@/app/dashboard/page")).default;
    sessionToken = (await import("@/lib/auth/session")).createSessionToken;
  });
  beforeEach(async () => {
    await truncateAll(db);
    cookieValue.mockReset();
  });
  afterAll(() => pool.end());

  it("redirects to /login without a session", async () => {
    await expect(DashboardPage()).rejects.toThrow("REDIRECT:/login");
  });

  it("redirects to /login with a forged token", async () => {
    cookieValue.mockReturnValue("nope.123.abc");
    await expect(DashboardPage()).rejects.toThrow("REDIRECT:/login");
  });

  it("renders for a signed-in host", async () => {
    const [user] = await db.insert(users).values({ email: "host@example.com", passwordHash: "x" }).returning();
    cookieValue.mockReturnValue(sessionToken(user.id));
    const element = await DashboardPage();
    expect(JSON.stringify(element)).toContain("host@example.com");
  });
});
