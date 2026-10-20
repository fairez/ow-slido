import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { workspaces } from "@/db/schema";
import { BrandingSettings } from "@/components/branding-settings";
import { DeleteWorkspace } from "@/components/delete-workspace";
import { LanguageSettings } from "@/components/language-settings";
import { RetentionSettings } from "@/components/retention-settings";
import { can } from "@/lib/auth/permissions";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { redirectIfTwoFactorMissing } from "@/lib/auth/two-factor-policy";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { getDb } from "@/lib/db";
import { getEntitlements } from "@/lib/plans";
import { brandingLock } from "@/lib/plan-hints";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const t = await getT();
  const jar = await cookies();
  const user = await getUserFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  const membership = resolveActiveMembership(user.memberships, jar.get(WORKSPACE_COOKIE)?.value);
  if (!membership) redirect("/login");
  await redirectIfTwoFactorMissing(membership.workspaceId, user.id);
  const canManage = can(membership.role, "members.manage");

  const [workspace] = await getDb()
    .select({ name: workspaces.name, retentionDays: workspaces.retentionDays, brandAccent: workspaces.brandAccent })
    .from(workspaces)
    .where(eq(workspaces.id, membership.workspaceId));

  const { limits } = await getEntitlements(membership.workspaceId);

  return (
    <main id="main" className="page">
      <Link href="/dashboard" className="back-link">
        {t("dash.backToEvents")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("settings.title")}</h1>
          <p className="row-meta">{t(canManage ? "settings.lead" : "settings.leadPersonal")}</p>
        </div>
      </header>
      <div className="stack">
        <LanguageSettings />
        {canManage && <RetentionSettings initial={workspace?.retentionDays ?? null} />}
        {canManage && can(membership.role, "branding.manage") && (
          <BrandingSettings initial={workspace?.brandAccent ?? null} lock={brandingLock(limits)} />
        )}
        {canManage && workspace && can(membership.role, "workspace.delete") && <DeleteWorkspace name={workspace.name} />}
      </div>
    </main>
  );
}
