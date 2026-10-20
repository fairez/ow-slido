import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
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
  return { list, activeId: active.workspaceId };
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
          <Link href="/">{t("shell.join")}</Link>
        </nav>
        {workspaces ? <WorkspaceSwitcher workspaces={workspaces.list} activeId={workspaces.activeId} /> : null}
        <ThemeToggle />
      </header>
      {children}
    </>
  );
}
