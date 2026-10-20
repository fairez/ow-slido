// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect,
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: async () => [{ id: EVENT_ID, name: "Evt", joinCode: "123456" }] }) }),
  }),
}));

vi.mock("@/lib/workspace-suspension", () => ({ eventUnavailable: async () => false }));

beforeEach(() => {
  redirect.mockClear();
});

async function visit(search: { j?: string }) {
  const { default: Page } = await import("@/app/e/[eventId]/page");
  return Page({ params: Promise.resolve({ eventId: EVENT_ID }), searchParams: Promise.resolve(search) });
}

test("a first visit without a participant cookie goes to join", async () => {
  await expect(visit({})).rejects.toThrow("REDIRECT /join/123456");
});

test("right after a successful join, a missing cookie means the browser dropped it: no join loop", async () => {
  await expect(visit({ j: "1" })).rejects.toThrow("REDIRECT /join/123456?cookies=blocked");
});
