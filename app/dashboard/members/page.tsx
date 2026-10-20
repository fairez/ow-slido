import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MembersManager } from "@/components/members-manager";
import { can } from "@/lib/auth/permissions";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { getDb } from "@/lib/db";
import { getT } from "@/lib/i18n/server";
import { listInvitations } from "@/lib/invitations";
import { listMembers } from "@/lib/members";
import { PLAN_IDS, PLANS, getEntitlements } from "@/lib/plans";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const t = await getT();
  const jar = await cookies();
  const user = await getUserFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  const membership = resolveActiveMembership(user.memberships, jar.get(WORKSPACE_COOKIE)?.value);
  if (!membership) redirect("/login");
  if (!can(membership.role, "members.manage")) redirect("/dashboard");

  const db = getDb();
  const [members, invitations, entitlements] = await Promise.all([
    listMembers(db, membership.workspaceId),
    listInvitations(db, membership.workspaceId),
    getEntitlements(membership.workspaceId, { db }),
  ]);

  return (
    <main id="main" className="page">
      <Link href="/dashboard" className="back-link">
        {t("dash.backToEvents")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("members.title")}</h1>
          <p className="row-meta">{t("members.lead")}</p>
        </div>
      </header>
      <MembersManager
        selfId={user.id}
        actorRole={membership.role}
        seatTiers={{ current: entitlements.plan, tiers: PLAN_IDS.map((plan) => ({ plan, seats: PLANS[plan].seats })) }}
        initialMembers={members.map((m) => ({
          ...m,
          joinedAt: m.joinedAt.toISOString(),
          lastLoginAt: m.lastLoginAt?.toISOString() ?? null,
        }))}
        initialInvitations={invitations.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          status: i.status,
          expiresAt: i.expiresAt.toISOString(),
        }))}
      />
    </main>
  );
}
