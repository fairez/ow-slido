import { denyIfPasswordChangeRequired, getSessionUser } from "@/lib/auth/require-admin";
import { TwoFactorNotConfiguredError, confirmEnrolment } from "@/lib/auth/two-factor";
import { recordAuditForUser } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";

/** Body `{ code }`. Turns 2FA on and returns the recovery codes, which are not shown again. */
export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
  const blocked = denyIfPasswordChangeRequired(request, user);
  if (blocked) return blocked;

  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";

  let result;
  try {
    result = await confirmEnrolment(getDb(), user.id, code);
  } catch (error) {
    if (error instanceof TwoFactorNotConfiguredError) {
      return Response.json({ error: serverT(request, "api.twoFactorUnavailable") }, { status: 503 });
    }
    throw error;
  }
  if (result.ok) {
    await recordAuditForUser(request, user, { action: "auth.2fa_enabled" });
    return Response.json({ recoveryCodes: result.recoveryCodes });
  }
  if (result.reason === "rate_limited") {
    return Response.json(
      { error: serverT(request, "api.tooManyAttempts") },
      { status: 429, headers: { "retry-after": String(result.retryAfterSeconds) } },
    );
  }
  if (result.reason === "not_enabled") {
    return Response.json({ error: serverT(request, "api.twoFactorNotStarted") }, { status: 409 });
  }
  return Response.json({ error: serverT(request, "api.twoFactorConfirmInvalid") }, { status: 400 });
}
