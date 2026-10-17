import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../db/client";

config({ path: ".env.local" });

const [command, target] = process.argv.slice(2);
const envName = target === "test" ? "TEST_DATABASE_URL" : "DATABASE_URL";
const url = process.env[envName];

async function main() {
  if (!url) throw new Error(`${envName} is not set`);
  const { db, pool } = createDb(url);
  try {
    if (command === "reset") {
      if (target !== "test") throw new Error("reset is only allowed for the test database");
      await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
      await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
      await db.execute(sql`CREATE SCHEMA public`);
    }
    const applied = async () => {
      try {
        const r = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
        return Number((r.rows[0] as { n: number }).n);
      } catch {
        return 0;
      }
    };
    const before = await applied();
    await migrate(db, { migrationsFolder: "./db/migrations" });
    const after = await applied();
    console.log(`migrated ${envName}: ${after - before} applied now, ${after} in total`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
