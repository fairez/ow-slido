import { cookies, headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { VerifyBanner } from "@/components/verify-banner";
import { NavLink } from "@/components/ui/nav-link";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { can } from "@/lib/auth/permissions";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { isOperator } from "@/lib/operator";
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
  return { list, activeId: active.workspaceId, canManageMembers: can(active.role, "members.manage"), canViewAudit: can(active.role, "audit.view"), unverifiedEmail: user.emailVerifiedAt ? null : user.email, operator: isOperator(user) };
}

export async function AppShell({ children }: { children: ReactNode }) {
  const t = await getT();
  const workspaces = await loadWorkspaces();
  // Join, participant, survey and presenter pages (see proxy.ts) show the event, not the product's links.
  const audiencePage = (await headers()).has("x-audience-path");
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
          <NavLink href="/dashboard" alsoUnder={["/dashboard/events"]}>{t("shell.events")}</NavLink>
          {workspaces ? <NavLink href="/dashboard/templates">{t("templates.nav")}</NavLink> : null}
          {workspaces?.canManageMembers ? <NavLink href="/dashboard/members">{t("members.nav")}</NavLink> : null}
          {workspaces ? <NavLink href="/dashboard/settings">{t("settings.nav")}</NavLink> : null}
          {workspaces?.canViewAudit ? <NavLink href="/dashboard/audit">{t("audit.nav")}</NavLink> : null}
          {workspaces ? <NavLink href="/dashboard/plan">{t("plan.nav")}</NavLink> : null}
          {workspaces?.operator ? <NavLink href="/ops">{t("ops.nav")}</NavLink> : null}
          {workspaces ? <NavLink href="/account/security">{t("security.nav")}</NavLink> : null}
          <NavLink href="/">{t("shell.join")}</NavLink>
        </nav>
        {workspaces ? <WorkspaceSwitcher workspaces={workspaces.list} activeId={workspaces.activeId} /> : null}
        <ThemeToggle />
      </header>
      {workspaces?.unverifiedEmail ? <VerifyBanner email={workspaces.unverifiedEmail} /> : null}
      {children}
      {audiencePage ? null : (
        <footer className="site-footer">
          <nav aria-label={t("shell.footerLabel")}>
            <Link href="/pricing">{t("shell.pricing")}</Link>
            <Link href="/terms">{t("legal.terms.nav")}</Link>
            <Link href="/privacy">{t("legal.privacy.nav")}</Link>
          </nav>
        </footer>
      )}
    </>
  );
}
