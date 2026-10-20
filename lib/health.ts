import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { jobRuns } from "@/db/schema";
import { getDb } from "@/lib/db";
import { DAILY_JOBS } from "@/lib/jobs";
import { ANALYSIS_STALE_MS } from "@/lib/note-analysis";
import { STUCK_AFTER_MS as EXPORT_STUCK_AFTER_MS } from "@/lib/workspace-export";

type Db = ReturnType<typeof getDb>;

/** Migrations the code expects, from the journal drizzle-kit writes next to the SQL files. */
export function expectedMigrations(): number | null {
  try {
    const journal = JSON.parse(readFileSync(path.join(process.cwd(), "db/migrations/meta/_journal.json"), "utf8"));
    return Array.isArray(journal.entries) ? journal.entries.length : null;
  } catch {
    return null;
  }
}

export type JobState = {
  /** `stuck` when something has been queued or running longer than the job's own timeout. */
  state: "idle" | "busy" | "stuck";
  queued: number;
  running: number;
  failedLast24h: number;
  /** Class of the newest failure in the last 24 hours (`Error`, `AiError:provider`), never a message. */
  lastErrorClass: string | null;
};

export type DailyJobState = { lastStartedAt: string | null; lastFinishedAt: string | null; status: "never" | "running" | "ok" | "failed"; errorClass: string | null };

export type HealthBody =
  | { status: "ok"; dailyJobs: Record<string, DailyJobState> | null; jobRunner: { exports: JobState; analysis: JobState } | null }
  | { status: "database unavailable" }
  | { status: "migrations pending"; applied: number; expected: number };

const DAY_MS = 24 * 60 * 60 * 1000;

async function jobState(db: Db, table: "workspace_exports" | "note_analyses", stuckAfterMs: number, now: Date): Promise<JobState> {
  const failedSince = new Date(now.getTime() - DAY_MS);
  const stuckBefore = new Date(now.getTime() - stuckAfterMs);
  const { rows } = await db.execute<{ queued: number; running: number; stuck: number; failed: number; last_class: string | null }>(sql`
    select
      count(*) filter (where status = 'queued')::int as queued,
      count(*) filter (where status = 'running')::int as running,
      count(*) filter (where status in ('queued', 'running') and created_at < ${stuckBefore})::int as stuck,
      count(*) filter (where status = 'failed' and finished_at >= ${failedSince})::int as failed,
      (select error_class from ${sql.identifier(table)} where status = 'failed' and finished_at >= ${failedSince} order by finished_at desc limit 1) as last_class
    from ${sql.identifier(table)}
  `);
  const row = rows[0];
  const queued = Number(row?.queued ?? 0);
  const running = Number(row?.running ?? 0);
  return {
    state: Number(row?.stuck ?? 0) > 0 ? "stuck" : queued + running > 0 ? "busy" : "idle",
    queued,
    running,
    failedLast24h: Number(row?.failed ?? 0),
    lastErrorClass: row?.last_class ?? null,
  };
}

async function dailyJobStates(db: Db): Promise<Record<string, DailyJobState>> {
  const rows = await db.select().from(jobRuns);
  return Object.fromEntries(
    DAILY_JOBS.map((name) => {
      const row = rows.find((r) => r.name === name);
      return [
        name,
        {
          lastStartedAt: row?.lastStartedAt.toISOString() ?? null,
          lastFinishedAt: row?.lastFinishedAt?.toISOString() ?? null,
          status: row?.lastStatus ?? "never",
          errorClass: row?.lastErrorClass ?? null,
        },
      ];
    }),
  );
}

/**
 * The deploy check: 503 when the database does not answer or a migration is missing, otherwise 200 with what the
 * recurring jobs and the export/analysis runner are doing. It reports counts, times and error classes only, never
 * configuration values, names, ids or content.
 */
export async function getHealth(db: Db = getDb(), now: Date = new Date()): Promise<{ status: 200 | 503; body: HealthBody }> {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return { status: 503, body: { status: "database unavailable" } };
  }

  const expected = expectedMigrations();
  if (expected !== null) {
    let applied = 0;
    try {
      const result = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      applied = Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
    } catch {
      applied = 0; // the migrations table does not exist yet
    }
    if (applied < expected) return { status: 503, body: { status: "migrations pending", applied, expected } };
  }

  try {
    const [dailyJobs, exportsState, analysisState] = await Promise.all([
      dailyJobStates(db),
      jobState(db, "workspace_exports", EXPORT_STUCK_AFTER_MS, now),
      jobState(db, "note_analyses", ANALYSIS_STALE_MS, now),
    ]);
    return { status: 200, body: { status: "ok", dailyJobs, jobRunner: { exports: exportsState, analysis: analysisState } } };
  } catch {
    // The job tables could not be read; the deploy check itself still passed.
    return { status: 200, body: { status: "ok", dailyJobs: null, jobRunner: null } };
  }
}
