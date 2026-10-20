import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OpsWorkspaceManager } from "@/components/ops-workspace-manager";
import { getUserFromToken } from "@/lib/auth/require-admin";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { getT } from "@/lib/i18n/server";
import { isOperator } from "@/lib/operator";
import { getOpsWorkspaceDetail } from "@/lib/ops-workspaces";

export const dynamic = "force-dynamic";

export default async function OpsWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!isOperator(user)) notFound();
  const { id } = await params;
  const detail = isUuid(id) ? await getOpsWorkspaceDetail(getDb(), id) : null;
  if (!detail) notFound();

  const t = await getT();
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return (
    <main id="main" className="page">
      <Link href="/ops" className="back-link">
        {t("ops.backToList")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{detail.name}</h1>
          <p className="row-meta">{t("ops.manageLead")}</p>
        </div>
      </header>
      <OpsWorkspaceManager
        initial={{
          ...detail,
          suspendedAt: iso(detail.suspendedAt),
          override: detail.override ? { ...detail.override, until: iso(detail.override.until) } : null,
        }}
      />
    </main>
  );
}
