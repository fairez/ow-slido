import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { workspaces } from "@/db/schema";
import { DeleteWorkspace } from "@/components/delete-workspace";
import { RetentionSettings } from "@/components/retention-settings";
import { can } from "@/lib/auth/permissions";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { redirectIfTwoFactorMissing } from "@/lib/auth/two-factor-policy";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { getDb } from "@/lib/db";
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
  if (!can(membership.role, "members.manage")) redirect("/dashboard");

  const [workspace] = await getDb()
    .select({ name: workspaces.name, retentionDays: workspaces.retentionDays })
    .from(workspaces)
    .where(eq(workspaces.id, membership.workspaceId));

  return (
    <main id="main" className="page">
      <Link href="/dashboard" className="back-link">
        {t("dash.backToEvents")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("settings.title")}</h1>
          <p className="row-meta">{t("settings.lead")}</p>
        </div>
      </header>
      <div className="stack">
        <RetentionSettings initial={workspace?.retentionDays ?? null} />
        {workspace && can(membership.role, "workspace.delete") && <DeleteWorkspace name={workspace.name} />}
      </div>
    </main>
  );
}
