import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OpsActivity } from "@/components/ops-activity";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getT } from "@/lib/i18n/server";
import { isOperator } from "@/lib/operator";
import { listOperatorActivity } from "@/lib/ops-audit";

export const dynamic = "force-dynamic";

export default async function OpsActivityPage() {
  const user = await getUserFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!isOperator(user)) notFound();

  const t = await getT();
  const page = await listOperatorActivity(getDb());
  return (
    <main id="main" className="page">
      <Link href="/ops" className="back-link">
        {t("ops.backToList")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("ops.activityTitle")}</h1>
          <p className="row-meta">{t("ops.activityLead")}</p>
        </div>
      </header>
      <OpsActivity initial={{ ...page, entries: page.entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })) }} />
    </main>
  );
}
