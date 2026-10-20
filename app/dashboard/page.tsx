import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { EventManager } from "@/components/event-manager";
import { getDb } from "@/lib/db";
import { overLimitEvents } from "@/lib/over-limit";
import { LogoutButton } from "@/components/logout-button";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const t = await getT();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await getUserFromToken(token);
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  const membership = resolveActiveMembership(user.memberships, (await cookies()).get(WORKSPACE_COOKIE)?.value);
  if (!membership) redirect("/login");

  const list = await getDb()
    .select()
    .from(events)
    .where(eq(events.workspaceId, membership.workspaceId))
    .orderBy(asc(events.startsAt), asc(events.createdAt));
  const locks = await overLimitEvents(membership.workspaceId);
  const initialEvents = list.map((e) => ({
    id: e.id,
    name: e.name,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    joinCode: e.joinCode,
    lock: locks.get(e.id) ?? null,
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
      <EventManager initialEvents={initialEvents} />
    </main>
  );
}
