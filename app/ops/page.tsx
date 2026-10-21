import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OpsAiPanel } from "@/components/ops-ai-panel";
import { OpsWorkspaces } from "@/components/ops-workspaces";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getT } from "@/lib/i18n/server";
import { isOperator } from "@/lib/operator";
import { getOpsAiStatus } from "@/lib/ops-ai";
import { listOpsWorkspaces } from "@/lib/ops-workspaces";

export const dynamic = "force-dynamic";

export default async function OpsPage() {
  const user = await getUserFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!isOperator(user)) notFound();

  const t = await getT();
  const db = getDb();
  const [page, ai] = await Promise.all([listOpsWorkspaces(db), getOpsAiStatus(db)]);

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
      <div className="stack">
        <OpsAiPanel initial={ai} />
        <p>
          <Link href="/ops/activity" className="back-link">{t("ops.activityLink")}</Link>
        </p>
        <OpsWorkspaces
          initial={{
            ...page,
            workspaces: page.workspaces.map((w) => ({
              ...w,
              createdAt: w.createdAt.toISOString(),
              suspendedAt: w.suspendedAt ? w.suspendedAt.toISOString() : null,
            })),
          }}
        />
      </div>
    </main>
  );
}
