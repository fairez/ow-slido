import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { events, workspaces } from "@/db/schema";
import { EventManager } from "@/components/event-manager";
import { getDb } from "@/lib/db";
import { overLimitEvents } from "@/lib/over-limit";
import { LogoutButton } from "@/components/logout-button";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { redirectIfTwoFactorMissing } from "@/lib/auth/two-factor-policy";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { getT } from "@/lib/i18n/server";
import { listTemplates } from "@/lib/templates";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const t = await getT();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await getUserFromToken(token);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  const membership = resolveActiveMembership(user.memberships, (await cookies()).get(WORKSPACE_COOKIE)?.value);
  if (!membership) redirect("/login");
  await redirectIfTwoFactorMissing(membership.workspaceId, user.id);

  const list = await getDb()
    .select()
    .from(events)
    .where(eq(events.workspaceId, membership.workspaceId))
    .orderBy(asc(events.startsAt), asc(events.createdAt));
  const [workspace] = await getDb()
    .select({ retentionDays: workspaces.retentionDays })
    .from(workspaces)
    .where(eq(workspaces.id, membership.workspaceId));
  const locks = await overLimitEvents(membership.workspaceId);
  const templates = await listTemplates(membership.workspaceId);
  const initialEvents = list.map((e) => ({
    id: e.id,
    name: e.name,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    joinCode: e.joinCode,
    lock: locks.get(e.id) ?? null,
    deletionNoticeSentAt: e.deletionNoticeSentAt?.toISOString() ?? null,
  }));

  return (
    <main id="main" className="page">
      <header className="page-head">
        <div>
          <h1>{t("dash.title")}</h1>
          <p className="row-meta">{t("dash.signedInAs", { email: user.email })}</p>
        </div>
        <LogoutButton />
      </header>
      <EventManager initialEvents={initialEvents} retentionDays={workspace?.retentionDays ?? null} templates={templates.map(({ id, name, items }) => ({ id, name, itemCount: items.length }))} />
    </main>
  );
}
