import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuditLog } from "@/components/audit-log";
import { PlanHint } from "@/components/plan-hint";
import { can } from "@/lib/auth/permissions";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { redirectIfTwoFactorMissing } from "@/lib/auth/two-factor-policy";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { listAuditActions, listAuditEntries } from "@/lib/audit-query";
import { getDb } from "@/lib/db";
import { getT } from "@/lib/i18n/server";
import { auditLogLock } from "@/lib/plan-hints";
import { getEntitlements } from "@/lib/plans";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const t = await getT();
  const jar = await cookies();
  const user = await getUserFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  const membership = resolveActiveMembership(user.memberships, jar.get(WORKSPACE_COOKIE)?.value);
  if (!membership) redirect("/login");
  await redirectIfTwoFactorMissing(membership.workspaceId, user.id);
  if (!can(membership.role, "audit.view")) redirect("/dashboard");

  const db = getDb();
  const { limits } = await getEntitlements(membership.workspaceId, { db });
  const lock = auditLogLock(limits);
  const [page, actions] = lock
    ? [null, []]
    : await Promise.all([listAuditEntries(db, membership.workspaceId), listAuditActions(db, membership.workspaceId)]);

  return (
    <main id="main" className="page">
      <Link href="/dashboard" className="back-link">
        {t("dash.backToEvents")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("audit.title")}</h1>
          <p className="row-meta">{t("audit.lead")}</p>
        </div>
      </header>
      {lock || !page ? (
        <div className="member-policy">
          <p>{t("audit.locked")}</p>
          <PlanHint lock={lock ?? { requiredPlan: null }}>{t("audit.lockedAction")}</PlanHint>
        </div>
      ) : (
        <AuditLog
          initial={{ ...page, entries: page.entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })) }}
          actions={actions}
        />
      )}
    </main>
  );
}
