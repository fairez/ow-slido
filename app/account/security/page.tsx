import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SecuritySettings } from "@/components/security-settings";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { getTwoFactorStatus, isTwoFactorConfigured, remainingRecoveryCodes } from "@/lib/auth/two-factor";
import { getDb } from "@/lib/db";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const t = await getT();
  const user = await getUserFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");

  const db = getDb();
  const { enabled } = await getTwoFactorStatus(db, user.id);
  return (
    <main id="main" className="page security-page">
      <Link href="/dashboard" className="back-link">
        {t("dash.backToEvents")}
      </Link>
      <h1>{t("security.title")}</h1>
      <p className="entry-lead">{t("security.lead")}</p>
      <SecuritySettings
        email={user.email}
        available={isTwoFactorConfigured()}
        enabled={enabled}
        recoveryCodesLeft={enabled ? await remainingRecoveryCodes(db, user.id) : 0}
      />
    </main>
  );
}
