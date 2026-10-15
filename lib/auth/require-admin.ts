import { and, eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { getDb } from "@/lib/db";
import { readSessionToken, verifySessionToken } from "./session";

export type AuthUser = { id: string; email: string; role: "admin" };

export async function getSessionUser(request: Request): Promise<AuthUser | null> {
  const token = readSessionToken(request);
  const userId = token && verifySessionToken(token);
  if (!userId) return null;
  const [user] = await getDb()
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.active, true)));
  return user ?? null;
}

export async function requireAdmin(
  request: Request,
): Promise<{ ok: true; user: AuthUser } | { ok: false; response: Response }> {
  const user = await getSessionUser(request);
  if (!user) {
    return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: true, user };
}
