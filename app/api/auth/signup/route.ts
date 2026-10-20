import { serverT } from "@/lib/i18n/server";
import { users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { MIN_PASSWORD_LENGTH, isValidEmail, readCredentials } from "@/lib/auth/credentials";
import { isSecureRequest, sessionSetCookie } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

/** Set ALLOW_SIGNUP=false once the admins exist, so strangers on a public deployment cannot create accounts. */
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

  const passwordHash = await hashPassword(creds.password);
  const [user] = await getDb()
    .insert(users)
    .values({ email: creds.email, passwordHash })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id, email: users.email });
  if (!user) {
    return Response.json({ error: serverT(request, "api.emailTaken") }, { status: 409 });
  }

  return Response.json(
    { user },
    { status: 201, headers: { "set-cookie": sessionSetCookie(user.id, isSecureRequest(request)) } },
  );
}
