import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TemplatesManager } from "@/components/templates-manager";
import { can } from "@/lib/auth/permissions";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { getT } from "@/lib/i18n/server";
import { listTemplates } from "@/lib/templates";
import { templateLock } from "@/lib/plan-hints";
import { getEntitlements } from "@/lib/plans";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const t = await getT();
  const jar = await cookies();
  const user = await getUserFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  const membership = resolveActiveMembership(user.memberships, jar.get(WORKSPACE_COOKIE)?.value);
  if (!membership) redirect("/login");

  const [list, { limits }] = await Promise.all([listTemplates(membership.workspaceId), getEntitlements(membership.workspaceId)]);

  return (
    <main id="main" className="page">
      <Link href="/dashboard" className="back-link">
        {t("dash.backToEvents")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("templates.title")}</h1>
          <p className="row-meta">{t("templates.lead")}</p>
        </div>
      </header>
      <TemplatesManager
        initialTemplates={list.map(({ id, name, kind, items }) => ({ id, name, kind, items }))}
        limit={limits.templates}
        canManage={can(membership.role, "templates.manage")}
        limitLock={templateLock(limits)}
      />
    </main>
  );
}
