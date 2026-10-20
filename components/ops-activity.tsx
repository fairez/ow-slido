"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError } from "@/components/ui/field";
import { apiError } from "@/lib/api-error";
import { NETWORK_ERROR } from "@/lib/copy";
import { useLocale, useT } from "@/lib/i18n/client";

export type OpsActivityRow = {
  id: string;
  workspaceId: string | null;
  workspaceName: string | null;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type OpsActivityData = { entries: OpsActivityRow[]; total: number; page: number; pageSize: number };

function metadataText(metadata: Record<string, unknown>) {
  return Object.entries(metadata)
    .map(([key, value]) => `${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`)
    .join(", ");
}

/** Operator actions across all workspaces, newest first. Times are UTC so the log reads the same for everyone. */
export function OpsActivity({ initial }: { initial: OpsActivityData }) {
  const t = useT();
  const locale = useLocale();
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const utc = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  async function load(page: number) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/ops/activity?page=${page}`);
      if (response.ok) setData((await response.json()) as OpsActivityData);
      else setError((await apiError(response)).message);
    } catch {
      setError(NETWORK_ERROR);
    }
    setLoading(false);
  }

  return (
    <div className="stack">
      {error && <InlineError>{error}</InlineError>}
      {data.entries.length === 0 ? (
        <EmptyState title={t("ops.activityEmptyTitle")}>{t("ops.activityEmptyBody")}</EmptyState>
      ) : (
        <ol className="row-list audit-list" aria-label={t("ops.activityLabel")}>
          {data.entries.map((entry) => {
            const detail = metadataText(entry.metadata);
            return (
              <li key={entry.id} className="audit-row">
                <p className="audit-time">{t("audit.timeUtc", { time: utc.format(new Date(entry.createdAt)) })}</p>
                <p className="audit-action">{entry.action}</p>
                <p className="row-meta audit-facts">
                  <span>{entry.actorLabel}</span>
                  {entry.workspaceId && entry.workspaceName ? (
                    <Link href={`/ops/workspaces/${entry.workspaceId}`}>{entry.workspaceName}</Link>
                  ) : null}
                </p>
                {detail && <p className="row-meta audit-detail">{detail}</p>}
              </li>
            );
          })}
        </ol>
      )}
      {pages > 1 && (
        <nav className="audit-pager" aria-label={t("ops.pager")}>
          <Button aria-disabled={data.page <= 1 || undefined} onClick={() => data.page > 1 && load(data.page - 1)}>
            {t("ops.previous")}
          </Button>
          <span className="row-meta">{t("ops.page", { page: data.page, pages })}</span>
          <Button aria-disabled={data.page >= pages || undefined} onClick={() => data.page < pages && load(data.page + 1)}>
            {t("ops.next")}
          </Button>
        </nav>
      )}
    </div>
  );
}
