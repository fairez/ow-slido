import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { VerifyBanner } from "@/components/verify-banner";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { can } from "@/lib/auth/permissions";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { getDb } from "@/lib/db";
import { getT } from "@/lib/i18n/server";
import { listActiveWorkspaces } from "@/lib/workspaces";

async function loadWorkspaces() {
  const jar = await cookies();
  const user = await getUserFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) return null;
  const active = resolveActiveMembership(user.memberships, jar.get(WORKSPACE_COOKIE)?.value);
  if (!active) return null;
  const list = await listActiveWorkspaces(getDb(), user.memberships);
  return { list, activeId: active.workspaceId, canManageMembers: can(active.role, "members.manage"), canViewAudit: can(active.role, "audit.view"), unverifiedEmail: user.emailVerifiedAt ? null : user.email };
}

export async function AppShell({ children }: { children: ReactNode }) {
  const t = await getT();
  const workspaces = await loadWorkspaces();
  return (
    <>
      <a className="skip-link" href="#main">
        {t("shell.skip")}
      </a>
      <header className="site-header">
        <Link className="site-name" href="/">
          {t("shell.brand")}
        </Link>
        <nav aria-label={t("shell.navLabel")} className="site-nav">
          <Link href="/dashboard">{t("shell.events")}</Link>
          {workspaces ? <Link href="/dashboard/templates">{t("templates.nav")}</Link> : null}
          {workspaces?.canManageMembers ? <Link href="/dashboard/members">{t("members.nav")}</Link> : null}
          {workspaces?.canManageMembers ? <Link href="/dashboard/settings">{t("settings.nav")}</Link> : null}
          {workspaces?.canViewAudit ? <Link href="/dashboard/audit">{t("audit.nav")}</Link> : null}
          {workspaces ? <Link href="/dashboard/plan">{t("plan.nav")}</Link> : null}
          {workspaces ? <Link href="/account/security">{t("security.nav")}</Link> : null}
          <Link href="/">{t("shell.join")}</Link>
        </nav>
        {workspaces ? <WorkspaceSwitcher workspaces={workspaces.list} activeId={workspaces.activeId} /> : null}
        <ThemeToggle />
      </header>
      {workspaces?.unverifiedEmail ? <VerifyBanner email={workspaces.unverifiedEmail} /> : null}
      {children}
    </>
  );
}
