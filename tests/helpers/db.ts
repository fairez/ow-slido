import { sql } from "drizzle-orm";
import { config } from "dotenv";
import { createDb } from "@/db/client";

config({ path: ".env.local" });

export function createTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  return createDb(url);
}

export async function truncateAll(db: ReturnType<typeof createTestDb>["db"]) {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  if (rows.length === 0) return;
  const names = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE ${names} RESTART IDENTITY CASCADE`));
}
