import { denyIfPasswordChangeRequired, getSessionUser } from "@/lib/auth/require-admin";
import { TwoFactorAlreadyEnabledError, TwoFactorNotConfiguredError, beginEnrolment } from "@/lib/auth/two-factor";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";

const ISSUER = "OW Slido";

/** Starts enrolment with a fresh secret. Nothing is enforced until `/confirm` accepts a first code. */
export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
  const blocked = denyIfPasswordChangeRequired(request, user);
  if (blocked) return blocked;

  try {
    const { secret, uri } = await beginEnrolment(getDb(), user, ISSUER);
    return Response.json({ secret, uri });
  } catch (error) {
    if (error instanceof TwoFactorAlreadyEnabledError) {
      return Response.json({ error: serverT(request, "api.twoFactorAlreadyEnabled") }, { status: 409 });
    }
    if (error instanceof TwoFactorNotConfiguredError) {
      return Response.json({ error: serverT(request, "api.twoFactorUnavailable") }, { status: 503 });
    }
    throw error;
  }
}
