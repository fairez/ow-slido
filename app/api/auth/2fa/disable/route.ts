import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { setSessionsValidAfter } from "@/lib/auth/password-reset";
import { denyIfPasswordChangeRequired, getSessionUser } from "@/lib/auth/require-admin";
import { isSecureRequest, sessionSetCookie } from "@/lib/auth/session";
import { TwoFactorNotConfiguredError, disableTwoFactor, getTwoFactorStatus, verifySecondFactor } from "@/lib/auth/two-factor";
import { recordAuditForUser } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";
import { rateLimit } from "@/lib/rate-limit";

const DISABLE_LIMIT = 10;
const DISABLE_WINDOW_SECONDS = 15 * 60;

const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyAttempts") },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
  );

/**
 * Body `{ password, code }` (`code` is an authenticator code or a recovery code). Turning 2FA off ends the
 * user's other sessions; the response carries a fresh cookie for this device.
 */
export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
  const blocked = denyIfPasswordChangeRequired(request, user);
  if (blocked) return blocked;

  const body = (await request.json().catch(() => null)) as { password?: unknown; code?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";
  const code = typeof body?.code === "string" ? body.code : "";

  const limit = await rateLimit(`2fa-disable:user:${user.id}`, DISABLE_LIMIT, DISABLE_WINDOW_SECONDS);
  if (!limit.allowed) return tooMany(request, limit.retryAfterSeconds);

  const db = getDb();
  if (!(await getTwoFactorStatus(db, user.id)).enabled) {
    return Response.json({ error: serverT(request, "api.twoFactorNotStarted") }, { status: 409 });
  }

  // Both checks always run and share one answer, so a failure does not say which half was wrong.
  const [row] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id));
  const passwordOk = row ? await verifyPassword(password, row.hash) : false;
  let second;
  try {
    second = await verifySecondFactor(db, user.id, code);
  } catch (error) {
    if (error instanceof TwoFactorNotConfiguredError) {
      return Response.json({ error: serverT(request, "api.twoFactorUnavailable") }, { status: 503 });
    }
    throw error;
  }
  if (!second.ok && second.reason === "rate_limited") return tooMany(request, second.retryAfterSeconds ?? 60);
  if (!passwordOk || !second.ok) {
    return Response.json({ error: serverT(request, "api.twoFactorDisableInvalid") }, { status: 400 });
  }

  await disableTwoFactor(db, user.id);
  await setSessionsValidAfter(db, user.id);
  await recordAuditForUser(request, user, { action: "auth.2fa_disabled", metadata: { otherSessionsEnded: true } });
  return Response.json({ ok: true }, { headers: { "set-cookie": sessionSetCookie(user.id, isSecureRequest(request)) } });
}
