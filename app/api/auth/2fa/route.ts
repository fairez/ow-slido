import { denyIfPasswordChangeRequired, getSessionUser } from "@/lib/auth/require-admin";
import { getTwoFactorStatus, isTwoFactorConfigured, remainingRecoveryCodes } from "@/lib/auth/two-factor";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";

/** Whether the signed-in user has 2FA on, and how many recovery codes are left. */
export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
  const blocked = denyIfPasswordChangeRequired(request, user);
  if (blocked) return blocked;

  const db = getDb();
  const status = await getTwoFactorStatus(db, user.id);
  return Response.json({
    ...status,
    available: isTwoFactorConfigured(),
    recoveryCodesLeft: status.enabled ? await remainingRecoveryCodes(db, user.id) : 0,
  });
}
