import { serverT } from "@/lib/i18n/server";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/credentials";
import { resetPasswordWithToken } from "@/lib/auth/password-reset";
import { isSecureRequest, sessionSetCookie } from "@/lib/auth/session";
import { getTwoFactorStatus } from "@/lib/auth/two-factor";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const RESET_LIMIT = 10;
const RESET_WINDOW_SECONDS = 15 * 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { token?: unknown; password?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token : "";
  const password = typeof body?.password === "string" ? body.password : "";

  const limit = await rateLimit(`reset:ip:${clientIp(request)}`, RESET_LIMIT, RESET_WINDOW_SECONDS);
  if (!limit.allowed) {
    return Response.json(
      { error: serverT(request, "api.tooManyAttempts") },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }
  // Checked before the link is spent, so a typo does not burn it.
  if (password.length < MIN_PASSWORD_LENGTH) {
    return Response.json({ error: serverT(request, "api.passwordMin", { min: MIN_PASSWORD_LENGTH }) }, { status: 400 });
  }

  const userId = token ? await resetPasswordWithToken(getDb(), token, password) : null;
  if (!userId) return Response.json({ error: serverT(request, "api.resetLinkInvalid") }, { status: 400 });

  // An emailed link must not stand in for the second factor: with 2FA on the user logs in normally.
  if ((await getTwoFactorStatus(getDb(), userId)).enabled) return Response.json({ ok: true, loginRequired: true });

  return Response.json({ ok: true }, { headers: { "set-cookie": sessionSetCookie(userId, isSecureRequest(request)) } });
}
