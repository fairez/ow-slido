import { serverT } from "@/lib/i18n/server";
import { and, eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { getDb } from "@/lib/db";
import { readSessionToken, verifySessionToken } from "./session";

export type AuthUser = { id: string; email: string; role: "admin" };

export async function getUserFromToken(token: string | null | undefined): Promise<AuthUser | null> {
  const userId = token && verifySessionToken(token);
  if (!userId) return null;
  const [user] = await getDb()
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.active, true)));
  return user ?? null;
}

export function getSessionUser(request: Request) {
  return getUserFromToken(readSessionToken(request));
}

export async function requireAdmin(
  request: Request,
): Promise<{ ok: true; user: AuthUser } | { ok: false; response: Response }> {
  const user = await getSessionUser(request);
  if (!user) {
    return { ok: false, response: Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 }) };
  }
  return { ok: true, user };
}
