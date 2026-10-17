import { users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { MIN_PASSWORD_LENGTH, isValidEmail, readCredentials } from "@/lib/auth/credentials";
import { isSecureRequest, sessionSetCookie } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

/** Set ALLOW_SIGNUP=false once the admins exist, so strangers on a public deployment cannot create accounts. */
const signupClosed = () => process.env.ALLOW_SIGNUP?.trim().toLowerCase() === "false";

export async function POST(request: Request) {
  if (signupClosed()) {
    return Response.json({ error: "Sign-up is closed. Ask an existing admin for an account." }, { status: 403 });
  }
  const creds = await readCredentials(request);
  if (!creds || !isValidEmail(creds.email)) {
    return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  }
  if (creds.password.length < MIN_PASSWORD_LENGTH) {
    return Response.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
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
    return Response.json({ error: "That email already has an account. Log in instead." }, { status: 409 });
  }

  return Response.json(
    { user },
    { status: 201, headers: { "set-cookie": sessionSetCookie(user.id, isSecureRequest(request)) } },
  );
}
