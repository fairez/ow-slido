import { serverT } from "@/lib/i18n/server";
import { getSessionUser, type AuthUser } from "@/lib/auth/require-admin";

/** Emails in `OPERATOR_EMAILS` (comma list, any case, spaces ignored). Read on every call so tests can stub the variable. */
export function operatorEmails(): string[] {
  return (process.env.OPERATOR_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Platform operators are the users whose email is in `OPERATOR_EMAILS` and has been verified, so a self-made
 * account with a listed address that nobody confirmed gets nothing. There is no way to grant this in the app.
 * An account that still has to change a temporary password is not an operator either.
 */
export function isOperator(user: Pick<AuthUser, "email" | "emailVerifiedAt" | "mustChangePassword"> | null | undefined): boolean {
  if (!user || !user.emailVerifiedAt || user.mustChangePassword) return false;
  return operatorEmails().includes(user.email.toLowerCase());
}

/**
 * Guard for `/api/ops/*`: the operator, or a 404 identical for anonymous visitors, members and unverified
 * operators, so the console's existence is not revealed.
 */
export async function requireOperator(
  request: Request,
): Promise<{ ok: true; user: AuthUser } | { ok: false; response: Response }> {
  const user = await getSessionUser(request);
  if (!user || !isOperator(user)) {
    return { ok: false, response: Response.json({ error: serverT(request, "notFound.title") }, { status: 404 }) };
  }
  return { ok: true, user };
}
