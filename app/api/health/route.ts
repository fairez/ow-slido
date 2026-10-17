import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Migrations the code expects, from the journal drizzle-kit writes next to the SQL files. */
function expectedMigrations(): number | null {
  try {
    const journal = JSON.parse(readFileSync(path.join(process.cwd(), "db/migrations/meta/_journal.json"), "utf8"));
    return Array.isArray(journal.entries) ? journal.entries.length : null;
  } catch {
    return null;
  }
}

/**
 * Deploy health check, no auth and no data: 200 when the database answers and every migration is
 * applied; 503 when it is unreachable or migrations are missing (the deploy then fails visibly
 * instead of serving an app whose tables do not exist).
 */
export async function GET() {
  const db = getDb();
  try {
    await db.execute(sql`select 1`);
  } catch {
    return Response.json({ status: "database unavailable" }, { status: 503 });
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
    if (applied < expected) {
      return Response.json({ status: "migrations pending", applied, expected }, { status: 503 });
    }
  }
  return Response.json({ status: "ok" });
}
