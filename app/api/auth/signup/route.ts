import { serverT } from "@/lib/i18n/server";
import { users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { MIN_PASSWORD_LENGTH, isValidEmail, readCredentials } from "@/lib/auth/credentials";
import { isSecureRequest, sessionSetCookie } from "@/lib/auth/session";
import { sendVerificationEmail } from "@/lib/auth/verification";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { createPersonalWorkspace } from "@/lib/workspaces";

/** Set ALLOW_SIGNUP=false once the admins exist, so strangers on a public deployment cannot create accounts. */
const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_SECONDS = 60 * 60;

const signupClosed = () => process.env.ALLOW_SIGNUP?.trim().toLowerCase() === "false";

export async function POST(request: Request) {
  if (signupClosed()) {
    return Response.json({ error: serverT(request, "api.signupClosed") }, { status: 403 });
  }
  const creds = await readCredentials(request);
  if (!creds || !isValidEmail(creds.email)) {
    return Response.json({ error: serverT(request, "api.emailInvalid") }, { status: 400 });
  }
  if (creds.password.length < MIN_PASSWORD_LENGTH) {
    return Response.json(
      { error: serverT(request, "api.passwordMin", { min: MIN_PASSWORD_LENGTH }) },
      { status: 400 },
    );
  }

  const [byIp, byEmail] = await Promise.all([
    rateLimit(`signup:ip:${clientIp(request)}`, SIGNUP_LIMIT, SIGNUP_WINDOW_SECONDS),
    rateLimit(`signup:email:${creds.email}`, SIGNUP_LIMIT, SIGNUP_WINDOW_SECONDS),
  ]);
  if (!byIp.allowed || !byEmail.allowed) {
    return Response.json(
      { error: serverT(request, "api.tooManyAttempts") },
      { status: 429, headers: { "retry-after": String(Math.max(byIp.retryAfterSeconds, byEmail.retryAfterSeconds)) } },
    );
  }

  const passwordHash = await hashPassword(creds.password);
  const user = await getDb().transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({ email: creds.email, passwordHash, emailVerifiedAt: null })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id, email: users.email });
    if (created) await createPersonalWorkspace(tx, created);
    return created;
  });
  if (!user) {
    return Response.json({ error: serverT(request, "api.emailTaken") }, { status: 409 });
  }

  await sendVerificationEmail(getDb(), request, user);

  return Response.json(
    { user },
    { status: 201, headers: { "set-cookie": sessionSetCookie(user.id, isSecureRequest(request)) } },
  );
}
