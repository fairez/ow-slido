import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OpsWorkspaces } from "@/components/ops-workspaces";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getT } from "@/lib/i18n/server";
import { isOperator } from "@/lib/operator";
import { listOpsWorkspaces } from "@/lib/ops-workspaces";

export const dynamic = "force-dynamic";

export default async function OpsPage() {
  const user = await getUserFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!isOperator(user)) notFound();

  const t = await getT();
  const page = await listOpsWorkspaces(getDb());

  return (
    <main id="main" className="page">
      <Link href="/dashboard" className="back-link">
        {t("dash.backToEvents")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("ops.title")}</h1>
          <p className="row-meta">{t("ops.lead")}</p>
        </div>
      </header>
      <OpsWorkspaces initial={{ ...page, workspaces: page.workspaces.map((w) => ({ ...w, createdAt: w.createdAt.toISOString() })) }} />
    </main>
  );
}
