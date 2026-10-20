import { eq, sql } from "drizzle-orm";
import { users } from "@/db/schema";
import { parsePendingTwoFactorToken } from "@/lib/auth/pending-two-factor";
import { setSessionsValidAfter } from "@/lib/auth/password-reset";
import { isSecureRequest, sessionSetCookie } from "@/lib/auth/session";
import { TwoFactorNotConfiguredError, verifySecondFactor } from "@/lib/auth/two-factor";
import { recordAuditForUser } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { localeSetCookie } from "@/lib/i18n/cookie";
import { serverT } from "@/lib/i18n/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const VERIFY_IP_LIMIT = 30;
const VERIFY_WINDOW_SECONDS = 15 * 60;

const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyAttempts") },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
  );

// An expired token, a wrong code and a spent recovery code all look the same from outside.
const invalid = (request: Request) => Response.json({ error: serverT(request, "api.twoFactorInvalid") }, { status: 401 });

/**
 * Second step of a login with 2FA. Body `{ pendingToken, code }` where `code` is an authenticator code or a
 * recovery code. A recovery code also ends the user's other sessions (it usually means a lost device).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { pendingToken?: unknown; code?: unknown } | null;
  const pendingToken = typeof body?.pendingToken === "string" ? body.pendingToken : "";
  const code = typeof body?.code === "string" ? body.code : "";

  const byIp = await rateLimit(`2fa-verify:ip:${clientIp(request)}`, VERIFY_IP_LIMIT, VERIFY_WINDOW_SECONDS);
  if (!byIp.allowed) return tooMany(request, byIp.retryAfterSeconds);

  const userId = parsePendingTwoFactorToken(pendingToken);
  if (!userId) return invalid(request);

  const db = getDb();
  const [user] = await db.select({ id: users.id, email: users.email, active: users.active, locale: users.locale }).from(users).where(eq(users.id, userId));
  if (!user?.active) return invalid(request);

  let result;
  try {
    result = await verifySecondFactor(db, userId, code);
  } catch (error) {
    if (error instanceof TwoFactorNotConfiguredError) {
      return Response.json({ error: serverT(request, "api.twoFactorUnavailable") }, { status: 503 });
    }
    throw error;
  }
  if (!result.ok) {
    await recordAuditForUser(request, user, { action: "auth.login_failed", metadata: { step: "second_factor", reason: result.reason } });
    return result.reason === "rate_limited" ? tooMany(request, result.retryAfterSeconds ?? 60) : invalid(request);
  }

  if (result.method === "recovery") await setSessionsValidAfter(db, userId);
  await db
    .update(users)
    .set({ firstLoginAt: sql`coalesce(${users.firstLoginAt}, now())`, lastLoginAt: sql`now()` })
    .where(eq(users.id, userId));

  await recordAuditForUser(request, user, { action: "auth.login", metadata: { secondFactor: true, method: result.method } });
  const secure = isSecureRequest(request);
  const headers = new Headers({ "set-cookie": sessionSetCookie(userId, secure) });
  if (user.locale) headers.append("set-cookie", localeSetCookie(user.locale, secure));
  return Response.json({ user: { id: user.id } }, { headers });
}
