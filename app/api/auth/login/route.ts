import { serverT } from "@/lib/i18n/server";
import { eq, sql } from "drizzle-orm";
import { users } from "@/db/schema";
import { readCredentials } from "@/lib/auth/credentials";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createPendingTwoFactorToken } from "@/lib/auth/pending-two-factor";
import { isSecureRequest, sessionSetCookie } from "@/lib/auth/session";
import { getTwoFactorStatus, isTwoFactorConfigured } from "@/lib/auth/two-factor";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;

const tooMany = (request: Request, retryAfterSeconds: number) =>
  Response.json(
    { error: serverT(request, "api.tooManyLogins") },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
  );

const invalid = (request: Request) => Response.json({ error: serverT(request, "api.loginInvalid") }, { status: 401 });

// Compared against when the email is unknown so response time doesn't reveal which emails exist.
const dummyHash = hashPassword("dummy-password-for-timing");

export async function POST(request: Request) {
  const creds = await readCredentials(request);
  if (!creds) return invalid(request);

  const [byIp, byEmail] = await Promise.all([
    rateLimit(`login:ip:${clientIp(request)}`, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS),
    rateLimit(`login:email:${creds.email}`, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS),
  ]);
  if (!byIp.allowed || !byEmail.allowed) {
    return tooMany(request, Math.max(byIp.retryAfterSeconds, byEmail.retryAfterSeconds));
  }

  const [user] = await getDb().select().from(users).where(eq(users.email, creds.email));
  const passwordOk = await verifyPassword(creds.password, user?.passwordHash ?? (await dummyHash));
  if (!user || !user.active || !passwordOk) return invalid(request);

  // With 2FA on, the password alone never makes a session: hand out a short-lived pending token instead.
  if ((await getTwoFactorStatus(getDb(), user.id)).enabled) {
    if (!isTwoFactorConfigured()) {
      return Response.json({ error: serverT(request, "api.twoFactorUnavailable") }, { status: 503 });
    }
    return Response.json({ twoFactorRequired: true, pendingToken: createPendingTwoFactorToken(user.id) });
  }

  await getDb()
    .update(users)
    .set({ firstLoginAt: sql`coalesce(${users.firstLoginAt}, now())`, lastLoginAt: sql`now()` })
    .where(eq(users.id, user.id));

  return Response.json(
    { user: { id: user.id, email: user.email } },
    { headers: { "set-cookie": sessionSetCookie(user.id, isSecureRequest(request)) } },
  );
}
