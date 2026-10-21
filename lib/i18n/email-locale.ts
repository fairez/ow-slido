import { sql } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { users } from "@/db/schema";
import type { Locale } from "./locale";

type Db = ReturnType<typeof createDb>["db"];

/**
 * The language of an email: the recipient's saved `users.locale` when they have an account that
 * chose one, otherwise `fallback` (the request's language, or the default for background jobs).
 */
export async function emailLocale(db: Db, email: string, fallback: Locale): Promise<Locale> {
  const [row] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`);
  return row?.locale ?? fallback;
}
