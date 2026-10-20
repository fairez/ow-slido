// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { noteAnalyses, users, workspaceExports } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";
import { seedFullEvent } from "./helpers/seed-event";
import { createPersonalWorkspace } from "@/lib/workspaces";

const { db, pool } = createTestDb();
let health: typeof import("@/app/api/health/route");
let jobs: typeof import("@/lib/jobs");

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  health = await import("@/app/api/health/route");
  jobs = await import("@/lib/jobs");
});
beforeEach(() => truncateAll(db));
afterEach(() => vi.restoreAllMocks());
afterAll(() => pool.end());

const MINUTE = 60 * 1000;

describe("GET /api/health", () => {
  it("reports ok without authentication, with idle jobs and daily jobs that never ran", async () => {
    const res = await health.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      dailyJobs: {
        subscriptions: { lastStartedAt: null, lastFinishedAt: null, status: "never", errorClass: null },
        retention: { lastStartedAt: null, lastFinishedAt: null, status: "never", errorClass: null },
      },
      jobRunner: {
        exports: { state: "idle", queued: 0, running: 0, failedLast24h: 0, lastErrorClass: null },
        analysis: { state: "idle", queued: 0, running: 0, failedLast24h: 0, lastErrorClass: null },
      },
    });
  });

  it("never exposes configuration values", async () => {
    vi.stubEnv("SESSION_SECRET", "sentinel-session-secret-value");
    vi.stubEnv("OPENAI_API_KEY", "sentinel-openai-key-value");
    const text = JSON.stringify(await (await health.GET()).json());
    for (const value of [process.env.TEST_DATABASE_URL, "sentinel-session-secret-value", "sentinel-openai-key-value"]) {
      expect(text).not.toContain(value as string);
    }
    vi.unstubAllEnvs();
  });

  it("answers 503 when a migration is pending", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "health-"));
    mkdirSync(path.join(dir, "db/migrations/meta"), { recursive: true });
    writeFileSync(path.join(dir, "db/migrations/meta/_journal.json"), JSON.stringify({ entries: Array.from({ length: 9999 }, (_, i) => ({ idx: i })) }));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const res = await health.GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ status: "migrations pending", expected: 9999 });
    expect(body.applied).toBeLessThan(9999);
  });

  it("answers 503 when the database is unreachable", async () => {
    const { getHealth } = await import("@/lib/health");
    const broken = { execute: async () => Promise.reject(new Error("connect ECONNREFUSED secret-host")) } as unknown as Parameters<typeof getHealth>[0];
    const result = await getHealth(broken);
    expect(result).toEqual({ status: 503, body: { status: "database unavailable" } });
  });

  it("shows the last run of the daily jobs, a failure with its class only", async () => {
    await jobs.recordJobRun("subscriptions", async () => 1);
    await expect(
      jobs.recordJobRun("retention", async () => {
        throw Object.assign(new Error("failed for a@example.com"), { code: "ECONNRESET" });
      }),
    ).rejects.toThrow();
    const body = await (await health.GET()).json();
    expect(body.dailyJobs.subscriptions).toMatchObject({ status: "ok", errorClass: null });
    expect(body.dailyJobs.subscriptions.lastFinishedAt).toBeTruthy();
    expect(body.dailyJobs.retention).toMatchObject({ status: "failed", errorClass: "Error:ECONNRESET" });
    expect(JSON.stringify(body)).not.toContain("example.com");
  });

  it("shows the daily sweeps once they have run", async () => {
    const { startRetentionSweep } = await import("@/lib/retention");
    const { startSubscriptionSweep } = await import("@/lib/billing/expire");
    const stops = [startRetentionSweep(db), startSubscriptionSweep(db)];
    try {
      await vi.waitFor(async () => {
        const body = await (await health.GET()).json();
        expect(body.dailyJobs.retention.status).toBe("ok");
        expect(body.dailyJobs.subscriptions.status).toBe("ok");
      });
    } finally {
      stops.forEach((stop) => stop());
    }
  });

  it("reports failed and stuck export and analysis jobs", async () => {
    const [user] = await db.insert(users).values({ email: "o@example.com", passwordHash: "x", emailVerifiedAt: new Date() }).returning();
    const workspace = await createPersonalWorkspace(db, user);
    await seedFullEvent(db, workspace.id, user.id); // leaves one queued analysis row
    const now = Date.now();
    await db.insert(workspaceExports).values({ workspaceId: workspace.id, status: "failed", errorClass: "Error:ETIMEDOUT", finishedAt: new Date(now - MINUTE) });
    await db.insert(workspaceExports).values({ workspaceId: workspace.id, status: "running", createdAt: new Date(now - 45 * MINUTE), startedAt: new Date(now - 45 * MINUTE) });
    await db.update(noteAnalyses).set({ status: "queued" });
    const body = await (await health.GET()).json();
    expect(body.jobRunner.exports).toEqual({ state: "stuck", queued: 0, running: 1, failedLast24h: 1, lastErrorClass: "Error:ETIMEDOUT" });
    expect(body.jobRunner.analysis).toMatchObject({ state: "busy", queued: 1, running: 0 });
  });
});

describe("runWithRetry", () => {
  const noWait = { delays: [10, 20, 30], sleep: async () => {} };

  it("retries a failing job and returns the first success", async () => {
    const slept: number[] = [];
    let calls = 0;
    const result = await jobs.runWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("flaky");
        return "done";
      },
      { delays: [10, 20, 30], sleep: async (ms) => void slept.push(ms) },
    );
    expect(result).toEqual({ ok: true, value: "done", attempts: 3 });
    expect(slept).toEqual([10, 20]);
  });

  it("gives up after three retries and keeps only the error class", async () => {
    const slept: number[] = [];
    let calls = 0;
    const result = await jobs.runWithRetry(
      async () => {
        calls += 1;
        throw new Error("note text: do not store");
      },
      { delays: [10, 20, 30], sleep: async (ms) => void slept.push(ms) },
    );
    expect(calls).toBe(4);
    expect(slept).toEqual([10, 20, 30]);
    expect(result).toMatchObject({ ok: false, attempts: 4, errorClass: "Error" });
  });

  it("does not retry a permanent failure", async () => {
    let calls = 0;
    const result = await jobs.runWithRetry(async () => {
      calls += 1;
      throw jobs.permanentError("not available");
    }, noWait);
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, attempts: 1 });
    const cap = await jobs.runWithRetry(async () => Promise.reject(Object.assign(new Error("cap"), { name: "AiError", code: "daily_cap" })), noWait);
    expect(cap).toMatchObject({ ok: false, attempts: 1, errorClass: "AiError:daily_cap" });
  });

  it("reads the class from the name and code, never the message", () => {
    expect(jobs.errorClass(new TypeError("x@example.com"))).toBe("TypeError");
    expect(jobs.errorClass(Object.assign(new Error("m"), { code: "23505" }))).toBe("Error:23505");
    expect(jobs.errorClass(Object.assign(new Error("m"), { code: "has spaces and a@b.c" }))).toBe("Error");
    expect(jobs.errorClass("a string with content")).toBe("UnknownError");
  });
});
