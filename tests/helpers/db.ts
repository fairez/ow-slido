import { eq, sql } from "drizzle-orm";
import { config } from "dotenv";
import { createDb } from "@/db/client";
import { subscriptions, users } from "@/db/schema";
import { ensureQaInteraction } from "@/lib/questions";
import { createPersonalWorkspace } from "@/lib/workspaces";

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

/** Give an existing user a personal workspace (as sign-up does) and return its id, for inserting events directly. */
export async function workspaceFor(db: ReturnType<typeof createTestDb>["db"], userId: string) {
  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId));
  return (await createPersonalWorkspace(db, user)).id;
}

/** Puts a workspace on `plan` through a plan override, so tests do not need a billing provider. */
export async function setPlan(
  db: ReturnType<typeof createTestDb>["db"],
  workspaceId: string,
  plan: "free" | "pro" | "team",
) {
  await db
    .insert(subscriptions)
    .values({ workspaceId, planOverride: plan, planOverrideReason: "test" })
    .onConflictDoUpdate({ target: subscriptions.workspaceId, set: { planOverride: plan, planOverrideReason: "test" } });
}

/** The event's Q&A interaction (created if missing), for tests that insert questions directly. */
export const qaFor = (db: ReturnType<typeof createTestDb>["db"], eventId: string) => ensureQaInteraction(db, eventId);
