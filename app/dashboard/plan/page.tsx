import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PlanOverview } from "@/components/plan-overview";
import { can } from "@/lib/auth/permissions";
import { getBillingControls } from "@/lib/billing/status";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { redirectIfTwoFactorMissing } from "@/lib/auth/two-factor-policy";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { getDb } from "@/lib/db";
import { getLocale, getT } from "@/lib/i18n/server";
import { getEntitlements } from "@/lib/plans";
import { getUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ checkout?: string | string[] }> }) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const jar = await cookies();
  const user = await getUserFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  const membership = resolveActiveMembership(user.memberships, jar.get(WORKSPACE_COOKIE)?.value);
  if (!membership) redirect("/login");
  await redirectIfTwoFactorMissing(membership.workspaceId, user.id);

  const canManageBilling = can(membership.role, "billing.manage");
  const { checkout } = await searchParams;
  const checkoutResult = checkout === "success" || checkout === "canceled" ? checkout : null;

  const db = getDb();
  const [entitlements, usage, billing] = await Promise.all([
    getEntitlements(membership.workspaceId, { db }),
    getUsage(membership.workspaceId, { db }),
    getBillingControls(membership.workspaceId),
  ]);

  return (
    <main id="main" className="page">
      <Link href="/dashboard" className="back-link">
        {t("dash.backToEvents")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("plan.title")}</h1>
          <p className="row-meta">{t("plan.lead")}</p>
        </div>
      </header>
      <PlanOverview
        entitlements={entitlements}
        usage={usage}
        canManageBilling={canManageBilling}
        billing={billing}
        checkout={canManageBilling ? checkoutResult : null}
        locale={locale}
        t={t}
      />
    </main>
  );
}
