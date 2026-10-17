export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

// Counts hits per key in fixed windows. Async so a Redis adapter can replace the in-memory one.
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
  reset(): Promise<void>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private entries = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, windowMs: number) {
    const now = Date.now();
    // Drop expired entries so the map doesn't grow without bound.
    for (const [k, v] of this.entries) if (v.resetAt <= now) this.entries.delete(k);

    const entry = this.entries.get(key) ?? { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    this.entries.set(key, entry);
    return { ...entry };
  }

  async reset() {
    this.entries.clear();
  }
}

let store: RateLimitStore = new MemoryRateLimitStore();

export function setRateLimitStore(next: RateLimitStore) {
  store = next;
}

export function getRateLimitStore() {
  return store;
}

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const { count, resetAt } = await store.hit(key, windowSeconds * 1000);
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
  };
}

export function clientIp(request: Request) {
  // Behind a hosting proxy (Railway) x-real-ip is set by the proxy itself; the first x-forwarded-for
  // entry can carry whatever the client sent, so it is only the fallback.
  const real = request.headers.get("x-real-ip")?.trim();
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return real || forwarded || "unknown";
}
