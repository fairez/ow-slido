"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError, Select, TextField } from "@/components/ui/field";
import { apiError } from "@/lib/api-error";
import { NETWORK_ERROR } from "@/lib/copy";
import { useLocale, useT } from "@/lib/i18n/client";

export type AuditEntry = {
  id: string;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
};

export type AuditPageData = { entries: AuditEntry[]; total: number; page: number; pageSize: number };

type Filters = { action: string; actor: string; from: string; to: string };
const NO_FILTERS: Filters = { action: "", actor: "", from: "", to: "" };

const noSubscription = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The browser's time zone; "UTC" on the server and during hydration so both renders agree. */
function useTimeZone() {
  return useSyncExternalStore(noSubscription, browserZone, () => "UTC");
}

/** Start of the local day for `YYYY-MM-DD`, shifted by `days`. */
function localDay(value: string, days = 0) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d + days);
}

function query(filters: Filters, page: number) {
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.actor.trim()) params.set("actor", filters.actor.trim());
  if (filters.from) params.set("from", localDay(filters.from).toISOString());
  if (filters.to) params.set("to", localDay(filters.to, 1).toISOString());
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `/api/audit?${text}` : "/api/audit";
}

function metadataText(metadata: Record<string, unknown>) {
  return Object.entries(metadata)
    .map(([key, value]) => `${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`)
    .join(", ");
}

/** Filterable, paged list of the workspace's audit entries. Times are shown in the viewer's zone with the UTC value beside them. */
export function AuditLog({ initial, actions }: { initial: AuditPageData; actions: string[] }) {
  const t = useT();
  const locale = useLocale();
  const zone = useTimeZone();
  const [data, setData] = useState(initial);
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const local = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium", timeZone: zone });
  const utc = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const filtered = Object.values(applied).some(Boolean);

  async function load(filters: Filters, page: number) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(query(filters, page));
      if (response.ok) {
        setData((await response.json()) as AuditPageData);
        setApplied(filters);
      } else {
        setError((await apiError(response)).message);
      }
    } catch {
      setError(NETWORK_ERROR);
    }
    setLoading(false);
  }

  function apply(event: FormEvent) {
    event.preventDefault();
    if (draft.from && draft.to && localDay(draft.from) > localDay(draft.to)) {
      setError(t("audit.badDateRange"));
      return;
    }
    void load(draft, 1);
  }

  function clear() {
    setDraft(NO_FILTERS);
    void load(NO_FILTERS, 1);
  }

  const firstShown = (data.page - 1) * data.pageSize + 1;

  return (
    <div className="stack">
      <form className="audit-filters" onSubmit={apply} aria-label={t("audit.filters")}>
        <Select label={t("audit.filterAction")} value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
          <option value="">{t("audit.filterActionAny")}</option>
          {actions.map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </Select>
        <TextField label={t("audit.filterActor")} value={draft.actor} maxLength={200} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} />
        <TextField label={t("audit.filterFrom")} type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        <TextField label={t("audit.filterTo")} type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        <div className="audit-filter-actions">
          <Button type="submit" variant="primary" aria-busy={loading || undefined}>
            {t("audit.apply")}
          </Button>
          <Button variant="quiet" onClick={clear}>
            {t("audit.clear")}
          </Button>
        </div>
      </form>

      {error && <InlineError>{error}</InlineError>}
      <p className="row-meta" aria-live="polite">
        {loading ? t("audit.loading") : data.total > 0 ? `${t("audit.summary", { from: firstShown, to: firstShown + data.entries.length - 1, total: data.total })}. ` : ""}
        {t("audit.zone", { zone })}
      </p>

      {data.entries.length === 0 ? (
        filtered ? (
          <EmptyState title={t("audit.noMatchTitle")}>{t("audit.noMatchBody")}</EmptyState>
        ) : (
          <EmptyState title={t("audit.emptyTitle")}>{t("audit.emptyBody")}</EmptyState>
        )
      ) : (
        <ol className="row-list audit-list" aria-label={t("audit.listLabel")}>
          {data.entries.map((entry) => {
            const when = new Date(entry.createdAt);
            const detail = metadataText(entry.metadata);
            return (
              <li key={entry.id} className="audit-row">
                <p className="audit-time">
                  <time dateTime={entry.createdAt} title={t("audit.timeUtc", { time: utc.format(when) })}>
                    {local.format(when)}
                  </time>
                  <span className="audit-utc">{t("audit.timeUtc", { time: utc.format(when) })}</span>
                </p>
                <p className="audit-action">{entry.action}</p>
                <p className="row-meta audit-facts">
                  <span>{t("audit.actor", { actor: entry.actorLabel })}</span>
                  {entry.targetType && (
                    <span>{t("audit.target", { target: entry.targetId ? `${entry.targetType} ${entry.targetId}` : entry.targetType })}</span>
                  )}
                  {entry.ip && <span>{t("audit.ip", { ip: entry.ip })}</span>}
                </p>
                {detail && <p className="row-meta audit-detail">{detail}</p>}
              </li>
            );
          })}
        </ol>
      )}

      {pages > 1 && (
        <nav className="audit-pager" aria-label={t("audit.pager")}>
          <Button aria-disabled={data.page <= 1 || undefined} onClick={() => data.page > 1 && load(applied, data.page - 1)}>
            {t("audit.previous")}
          </Button>
          <span className="row-meta">{t("audit.page", { page: data.page, pages })}</span>
          <Button aria-disabled={data.page >= pages || undefined} onClick={() => data.page < pages && load(applied, data.page + 1)}>
            {t("audit.next")}
          </Button>
        </nav>
      )}
    </div>
  );
}
