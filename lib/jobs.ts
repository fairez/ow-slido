import { eq } from "drizzle-orm";
import { jobRuns } from "@/db/schema";
import { getDb } from "@/lib/db";

type Db = ReturnType<typeof getDb>;

/** Recurring jobs that `/api/health` reports on. */
export const DAILY_JOBS = ["subscriptions", "retention"] as const;
export type DailyJob = (typeof DAILY_JOBS)[number];

/** Retries after the first try; a job is tried at most `1 + JOB_MAX_RETRIES` times. */
export const JOB_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 20_000];

/** Waits before retry 1, 2 and 3. `JOB_RETRY_BACKOFF_MS` (comma separated milliseconds) overrides them, which tests use to run without waiting. */
export function retryDelays(): number[] {
  const raw = process.env.JOB_RETRY_BACKOFF_MS;
  if (!raw) return DEFAULT_BACKOFF_MS;
  const parsed = raw.split(",").map((part) => Number(part.trim()));
  return parsed.length > 0 && parsed.every((n) => Number.isFinite(n) && n >= 0) ? parsed : DEFAULT_BACKOFF_MS;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * What kind of failure this was, as `Name` or `Name:code` (`Error`, `AiError:provider`, `Error:23505`). The
 * message is never used: it can quote notes, answers or provider replies.
 */
export function errorClass(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UnknownError";
  const { name, code } = error as { name?: unknown; code?: unknown };
  const base = typeof name === "string" && SAFE_NAME.test(name) ? name : "Error";
  return typeof code === "string" && SAFE_CODE.test(code) ? `${base}:${code}` : base;
}

/** Failures that cannot get better by waiting: a missing runner, a key that is not set, a spent cap. */
const PERMANENT_CODES = new Set(["not_configured", "event_cap", "daily_cap"]);

export function isPermanentFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { retryable, code } = error as { retryable?: unknown; code?: unknown };
  return retryable === false || (typeof code === "string" && PERMANENT_CODES.has(code));
}

/** An error that `runWithRetry` gives up on at once. */
export function permanentError(message: string) {
  return Object.assign(new Error(message), { retryable: false as const });
}

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: unknown; errorClass: string; attempts: number };

export type RetryOptions = {
  delays?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** Called before every try with its number (1 for the first), so a job row can show progress. */
  onAttempt?: (attempt: number) => Promise<void> | void;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `work`, retrying with backoff up to `JOB_MAX_RETRIES` times. Never throws. */
export async function runWithRetry<T>(work: () => Promise<T>, options: RetryOptions = {}): Promise<RetryResult<T>> {
  const delays = options.delays ?? retryDelays();
  const sleep = options.sleep ?? wait;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await options.onAttempt?.(attempt);
      return { ok: true, value: await work(), attempts: attempt };
    } catch (error) {
      if (attempt > JOB_MAX_RETRIES || isPermanentFailure(error)) {
        return { ok: false, error, errorClass: errorClass(error), attempts: attempt };
      }
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
    }
  }
}

/** Runs a recurring job and records when it started, finished and how it ended. A failure is recorded and rethrown. */
export async function recordJobRun<T>(name: string, work: () => Promise<T>, db: Db = getDb(), now: () => Date = () => new Date()): Promise<T> {
  // The record is a convenience for /api/health; losing it must never stop or fail the job.
  const note = (values: Partial<typeof jobRuns.$inferInsert>) =>
    db
      .insert(jobRuns)
      .values({ name, lastStartedAt: now(), lastStatus: "running", ...values })
      .onConflictDoUpdate({ target: jobRuns.name, set: values })
      .then(() => undefined)
      .catch((error) => console.error("> job record failed:", errorClass(error)));

  await note({ lastStartedAt: now(), lastFinishedAt: null, lastStatus: "running", lastErrorClass: null });
  try {
    const value = await work();
    await note({ lastFinishedAt: now(), lastStatus: "ok", lastErrorClass: null });
    return value;
  } catch (error) {
    await note({ lastFinishedAt: now(), lastStatus: "failed", lastErrorClass: errorClass(error) });
    throw error;
  }
}

export async function getJobRun(name: string, db: Db = getDb()) {
  const [row] = await db.select().from(jobRuns).where(eq(jobRuns.name, name));
  return row ?? null;
}
