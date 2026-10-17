// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clientIp, MemoryRateLimitStore, rateLimit, setRateLimitStore } from "@/lib/rate-limit";

beforeEach(() => {
  vi.useFakeTimers();
  setRateLimitStore(new MemoryRateLimitStore());
});
afterEach(() => vi.useRealTimers());

test("allows calls under the limit and reports remaining", async () => {
  const first = await rateLimit("k", 3, 60);
  expect(first).toMatchObject({ allowed: true, remaining: 2 });
  expect(await rateLimit("k", 3, 60)).toMatchObject({ allowed: true, remaining: 1 });
  expect(await rateLimit("k", 3, 60)).toMatchObject({ allowed: true, remaining: 0 });
});

test("blocks calls over the limit with a retry-after", async () => {
  for (let i = 0; i < 3; i++) await rateLimit("k", 3, 60);
  vi.advanceTimersByTime(10_000);
  const blocked = await rateLimit("k", 3, 60);
  expect(blocked).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 50 });
});

test("keys are independent", async () => {
  for (let i = 0; i < 3; i++) await rateLimit("a", 3, 60);
  expect((await rateLimit("a", 3, 60)).allowed).toBe(false);
  expect((await rateLimit("b", 3, 60)).allowed).toBe(true);
});

test("window resets after windowSeconds", async () => {
  for (let i = 0; i < 4; i++) await rateLimit("k", 3, 60);
  expect((await rateLimit("k", 3, 60)).allowed).toBe(false);
  vi.advanceTimersByTime(60_000);
  expect(await rateLimit("k", 3, 60)).toMatchObject({ allowed: true, remaining: 2 });
});

test("clientIp uses the proxy-set x-real-ip first, then the first x-forwarded-for entry", () => {
  const req = (h: Record<string, string>) => new Request("http://localhost", { headers: h });
  expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
  expect(clientIp(req({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
  expect(clientIp(req({ "x-real-ip": "8.8.8.8", "x-forwarded-for": "1.1.1.1, 8.8.8.8" }))).toBe("8.8.8.8");
  expect(clientIp(req({}))).toBe("unknown");
});
