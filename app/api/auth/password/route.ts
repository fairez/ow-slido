import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { serverT } from "@/lib/i18n/server";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/credentials";
import { verifyPassword } from "@/lib/auth/password";
import { setPassword } from "@/lib/auth/password-reset";
import { getSessionUser } from "@/lib/auth/require-admin";
import { isSecureRequest, sessionSetCookie } from "@/lib/auth/session";
import { recordAuditForUser } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

const CHANGE_LIMIT = 10;
const CHANGE_WINDOW_SECONDS = 15 * 60;

/** Reachable while `must_change_password` is set; it is how the flag gets cleared. */
export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { currentPassword?: unknown; newPassword?: unknown } | null;
  const current = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body?.newPassword === "string" ? body.newPassword : "";

  const limit = await rateLimit(`password:user:${user.id}`, CHANGE_LIMIT, CHANGE_WINDOW_SECONDS);
  if (!limit.allowed) {
    return Response.json(
      { error: serverT(request, "api.tooManyAttempts") },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    return Response.json({ error: serverT(request, "api.passwordMin", { min: MIN_PASSWORD_LENGTH }) }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id));
  if (!row || !(await verifyPassword(current, row.hash))) {
    return Response.json({ error: serverT(request, "api.currentPasswordWrong") }, { status: 400 });
  }

  await setPassword(db, user.id, next);
  await recordAuditForUser(request, user, { action: "auth.password_changed", metadata: { otherSessionsEnded: true } });
  return Response.json({ ok: true }, { headers: { "set-cookie": sessionSetCookie(user.id, isSecureRequest(request)) } });
}
