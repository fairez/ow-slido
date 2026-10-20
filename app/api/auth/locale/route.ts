import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { denyIfPasswordChangeRequired, getSessionUser } from "@/lib/auth/require-admin";
import { isSecureRequest } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { localeSetCookie } from "@/lib/i18n/cookie";
import { LOCALES } from "@/lib/i18n/locale";
import { serverT } from "@/lib/i18n/server";

/** Saves the signed-in user's interface language (`{locale: "en" | "id"}`) and sets the `lang` cookie to match. */
export async function PUT(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
  const blocked = denyIfPasswordChangeRequired(request, user);
  if (blocked) return blocked;

  const body = await request.json().catch(() => null);
  const locale = LOCALES.find((l) => l === body?.locale);
  if (!locale) return Response.json({ error: serverT(request, "api.localeInvalid") }, { status: 400 });

  await getDb().update(users).set({ locale }).where(eq(users.id, user.id));
  return Response.json({ locale }, { headers: { "set-cookie": localeSetCookie(locale, isSecureRequest(request)) } });
}
