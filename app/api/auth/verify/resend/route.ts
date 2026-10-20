import { serverT } from "@/lib/i18n/server";
import { getSessionUser } from "@/lib/auth/require-admin";
import { sendVerificationEmail } from "@/lib/auth/verification";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const RESEND_LIMIT = 3;
const RESEND_WINDOW_SECONDS = 15 * 60;

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
  if (user.emailVerifiedAt) return Response.json({ ok: true, alreadyVerified: true });

  const [byIp, byEmail] = await Promise.all([
    rateLimit(`verify-resend:ip:${clientIp(request)}`, RESEND_LIMIT * 3, RESEND_WINDOW_SECONDS),
    rateLimit(`verify-resend:email:${user.email}`, RESEND_LIMIT, RESEND_WINDOW_SECONDS),
  ]);
  if (!byIp.allowed || !byEmail.allowed) {
    return Response.json(
      { error: serverT(request, "api.tooManyAttempts") },
      { status: 429, headers: { "retry-after": String(Math.max(byIp.retryAfterSeconds, byEmail.retryAfterSeconds)) } },
    );
  }

  await sendVerificationEmail(getDb(), request, user);
  return Response.json({ ok: true });
}
