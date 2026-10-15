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
    await migrate(db, { migrationsFolder: "./db/migrations" });
    console.log(`migrated ${envName}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
