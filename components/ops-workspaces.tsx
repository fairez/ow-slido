"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState } from "@/components/ui/card";
import { InlineError, TextField } from "@/components/ui/field";
import { apiError } from "@/lib/api-error";
import { NETWORK_ERROR } from "@/lib/copy";
import { useLocale, useT } from "@/lib/i18n/client";

export type OpsWorkspaceRow = {
  id: string;
  name: string;
  plan: "free" | "pro" | "team";
  status: "active" | "trialing" | "past_due" | "canceled" | null;
  seatsUsed: number;
  members: number;
  eventsThisMonth: number;
  aiCallsThisMonth: number;
  ownerEmail: string | null;
  suspendedAt: string | null;
  createdAt: string;
};

export type OpsPageData = { workspaces: OpsWorkspaceRow[]; total: number; page: number; pageSize: number };

function url(q: string, page: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `/api/ops/workspaces?${text}` : "/api/ops/workspaces";
}

/** Searchable, paged list of every workspace, for the platform operator. */
export function OpsWorkspaces({ initial }: { initial: OpsPageData }) {
  const t = useT();
  const locale = useLocale();
  const [data, setData] = useState(initial);
  const [draft, setDraft] = useState("");
  const [applied, setApplied] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const numbers = new Intl.NumberFormat(locale);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const firstShown = (data.page - 1) * data.pageSize + 1;

  async function load(q: string, page: number) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(url(q, page));
      if (response.ok) {
        setData((await response.json()) as OpsPageData);
        setApplied(q);
      } else {
        setError((await apiError(response)).message);
      }
    } catch {
      setError(NETWORK_ERROR);
    }
    setLoading(false);
  }

  function search(event: FormEvent) {
    event.preventDefault();
    void load(draft.trim(), 1);
  }

  function clear() {
    setDraft("");
    void load("", 1);
  }

  return (
    <div className="stack">
      <form className="ops-search" onSubmit={search} role="search" aria-label={t("ops.searchForm")}>
        <TextField label={t("ops.search")} type="search" value={draft} maxLength={200} onChange={(e) => setDraft(e.target.value)} />
        <div className="ops-search-actions">
          <Button type="submit" variant="primary" aria-busy={loading || undefined}>
            {t("ops.searchApply")}
          </Button>
          <Button variant="quiet" onClick={clear}>
            {t("ops.searchClear")}
          </Button>
        </div>
      </form>

      {error && <InlineError>{error}</InlineError>}
      <p className="row-meta" aria-live="polite">
        {loading
          ? t("ops.loading")
          : data.total > 0
            ? t("ops.summary", { from: firstShown, to: firstShown + data.workspaces.length - 1, total: numbers.format(data.total) })
            : ""}
      </p>

      {data.workspaces.length === 0 ? (
        applied ? (
          <EmptyState title={t("ops.noMatchTitle")}>{t("ops.noMatchBody")}</EmptyState>
        ) : (
          <EmptyState title={t("ops.emptyTitle")}>{t("ops.emptyBody")}</EmptyState>
        )
      ) : (
        <ul className="row-list ops-list" aria-label={t("ops.listLabel")}>
          {data.workspaces.map((w) => (
            <li key={w.id} className="ops-row">
              <div className="ops-row-head">
                <h2>{w.name}</h2>
                <span className="ops-badges">
                  {w.suspendedAt && <Badge tone="accent">{t("ops.suspendedBadge")}</Badge>}
                  <Badge tone={w.plan === "free" ? "neutral" : "accent"}>{t(`plan.name.${w.plan}`)}</Badge>
                </span>
              </div>
              <p className="row-meta ops-owner">{w.ownerEmail ? `${t("ops.owner")}: ${w.ownerEmail}` : t("ops.noOwner")}</p>
              <dl className="ops-facts">
                <div>
                  <dt>{t("ops.status")}</dt>
                  <dd>{t(w.status ? `ops.status.${w.status}` : "ops.status.none")}</dd>
                </div>
                <div>
                  <dt>{t("ops.seats")}</dt>
                  <dd>{numbers.format(w.seatsUsed)}</dd>
                </div>
                <div>
                  <dt>{t("ops.members")}</dt>
                  <dd>{numbers.format(w.members)}</dd>
                </div>
                <div>
                  <dt>{t("ops.events")}</dt>
                  <dd>{numbers.format(w.eventsThisMonth)}</dd>
                </div>
                <div>
                  <dt>{t("ops.ai")}</dt>
                  <dd>{numbers.format(w.aiCallsThisMonth)}</dd>
                </div>
              </dl>
              <p className="ops-manage">
                <Link href={`/ops/workspaces/${w.id}`} aria-label={t("ops.manageFor", { name: w.name })}>
                  {t("ops.manage")}
                </Link>
              </p>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav className="audit-pager" aria-label={t("ops.pager")}>
          <Button aria-disabled={data.page <= 1 || undefined} onClick={() => data.page > 1 && load(applied, data.page - 1)}>
            {t("ops.previous")}
          </Button>
          <span className="row-meta">{t("ops.page", { page: data.page, pages })}</span>
          <Button aria-disabled={data.page >= pages || undefined} onClick={() => data.page < pages && load(applied, data.page + 1)}>
            {t("ops.next")}
          </Button>
        </nav>
      )}
    </div>
  );
}
