import { createDb } from "@/db/client";

type AppDb = ReturnType<typeof createDb>["db"];

const globalForDb = globalThis as unknown as { appDb?: AppDb };

export function getDb(): AppDb {
  if (!globalForDb.appDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.appDb = createDb(url).db;
  }
  return globalForDb.appDb;
}
