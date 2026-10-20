import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { workspaces } from "@/db/schema";
import { LogoutButton } from "@/components/logout-button";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { WORKSPACE_COOKIE, resolveActiveMembership } from "@/lib/auth/workspace";
import { getDb } from "@/lib/db";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

/** Where members land while the platform operator has their workspace suspended. */
export default async function SuspendedPage() {
  const t = await getT();
  const jar = await cookies();
  const user = await getUserFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const membership = resolveActiveMembership(user.memberships, jar.get(WORKSPACE_COOKIE)?.value);
  if (!membership) redirect("/dashboard");
  const [workspace] = await getDb()
    .select({ name: workspaces.name, suspendedAt: workspaces.suspendedAt })
    .from(workspaces)
    .where(eq(workspaces.id, membership.workspaceId));
  if (!workspace?.suspendedAt) redirect("/dashboard");

  return (
    <main id="main" className="page suspended-page">
      <h1>{t("suspended.title", { name: workspace.name })}</h1>
      <p className="entry-lead">{t("suspended.body")}</p>
      {user.memberships.filter((m) => m.status === "active").length > 1 && (
        <p className="row-meta">{t("suspended.switch")}</p>
      )}
      <div>
        <LogoutButton />
      </div>
    </main>
  );
}
