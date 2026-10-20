import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SecuritySettings } from "@/components/security-settings";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { twoFactorSetupRequired } from "@/lib/auth/two-factor-policy";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { getTwoFactorStatus, isTwoFactorConfigured, remainingRecoveryCodes } from "@/lib/auth/two-factor";
import { getDb } from "@/lib/db";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const t = await getT();
  const jar = await cookies();
  const user = await getUserFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");

  const db = getDb();
  const { enabled } = await getTwoFactorStatus(db, user.id);
  const membership = resolveActiveMembership(user.memberships, jar.get(WORKSPACE_COOKIE)?.value);
  const heldByWorkspace = membership ? await twoFactorSetupRequired(membership.workspaceId, user.id, db) : false;
  return (
    <main id="main" className="page security-page">
      <Link href="/dashboard" className="back-link">
        {t("dash.backToEvents")}
      </Link>
      <h1>{t("security.title")}</h1>
      <p className="entry-lead">{t("security.lead")}</p>
      {heldByWorkspace && (
        <p className="security-required" role="status">
          {t("security.workspaceRequires")}
        </p>
      )}
      <SecuritySettings
        email={user.email}
        available={isTwoFactorConfigured()}
        enabled={enabled}
        recoveryCodesLeft={enabled ? await remainingRecoveryCodes(db, user.id) : 0}
      />
      <p className="security-delete-link">
        <Link href="/account/delete">{t("security.deleteLink")}</Link>
      </p>
    </main>
  );
}
