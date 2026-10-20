import { serverT } from "@/lib/i18n/server";
import { isValidEmail } from "@/lib/auth/credentials";
import { sendResetEmail } from "@/lib/auth/password-reset";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const FORGOT_LIMIT = 3;
const FORGOT_WINDOW_SECONDS = 15 * 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) {
    return Response.json({ error: serverT(request, "api.emailInvalid") }, { status: 400 });
  }

  const [byIp, byEmail] = await Promise.all([
    rateLimit(`forgot:ip:${clientIp(request)}`, FORGOT_LIMIT * 3, FORGOT_WINDOW_SECONDS),
    rateLimit(`forgot:email:${email}`, FORGOT_LIMIT, FORGOT_WINDOW_SECONDS),
  ]);
  if (!byIp.allowed || !byEmail.allowed) {
    return Response.json(
      { error: serverT(request, "api.tooManyAttempts") },
      { status: 429, headers: { "retry-after": String(Math.max(byIp.retryAfterSeconds, byEmail.retryAfterSeconds)) } },
    );
  }

  await sendResetEmail(getDb(), request, email);
  // Same answer whether or not the address has an account.
  return Response.json({ ok: true });
}
