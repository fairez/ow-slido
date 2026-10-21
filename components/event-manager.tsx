"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { LiveParticipantCount } from "@/components/live-participant-count";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/card";
import { InlineError, Select, TextField } from "@/components/ui/field";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";
import { PlanError } from "@/components/plan-error";
import { PlanHint } from "@/components/plan-hint";
import { TypedConfirmDialog } from "@/components/typed-confirm-dialog";
import { apiError, type ApiError } from "@/lib/api-error";
import { useLocale, useT } from "@/lib/i18n/client";
import { LOCALES, type Locale } from "@/lib/i18n/locale";
import type { Lock } from "@/lib/plan-hints";
import { deletionDate, deletionIsNear, formatDeletionDay } from "@/lib/retention-schedule";

const noSubscription = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export type EventSummary = {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  joinCode: string;
  /** The language of the join, participant and presenter screens. */
  audienceLocale: Locale;
  /** Set when a downgrade left this event past the plan's monthly limit: it is read-only. */
  lock?: Lock | null;
  /** When the retention job warned about deleting this event, if it did. */
  deletionNoticeSentAt?: string | null;
};

const byStart = (a: EventSummary, b: EventSummary) =>
  new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();

function joinUrl(code: string) {
  return `${window.location.origin}/join/${code}`;
}

async function errorFrom(response: Response) {
  const body = await response.json().catch(() => null);
  return body?.error ?? SERVER_ERROR;
}

export type TemplateOption = { id: string; name: string; itemCount: number };

export function EventManager({
  initialEvents,
  templates = [],
  retentionDays = null,
}: {
  initialEvents: EventSummary[];
  templates?: TemplateOption[];
  /** The workspace's retention period; events get a deletion badge when it is set. */
  retentionDays?: number | null;
}) {
  const t = useT();
  const hostLocale = useLocale();
  // The UI language and "UTC" render on the server and during hydration, then the browser's zone takes over.
  const timeZone = useSyncExternalStore(noSubscription, browserZone, () => "UTC");
  const when = (iso: string) =>
    new Intl.DateTimeFormat(hostLocale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso));
  const [now] = useState(() => new Date());
  const [events, setEvents] = useState([...initialEvents].sort(byStart));
  const [created, setCreated] = useState<EventSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<ApiError | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [pending, setPending] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<EventSummary | null>(null);

  async function createEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const templateId = String(data.get("templateId") ?? "");
    setPending(true);
    setError(null);
    setCreateError(null);
    setSkipped(0);
    try {
      const response = await fetch(templateId ? "/api/events/from-template" : "/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          startsAt: new Date(String(data.get("startsAt"))).toISOString(),
          endsAt: new Date(String(data.get("endsAt"))).toISOString(),
          audienceLocale: data.get("audienceLocale"),
          ...(templateId ? { templateId } : {}),
        }),
      });
      if (!response.ok) {
        setCreateError(await apiError(response));
        return;
      }
      const { event: saved, skipped: left = 0 } = (await response.json()) as { event: EventSummary; skipped?: number };
      setEvents((list) => [...list, saved].sort(byStart));
      setCreated(saved);
      setSkipped(left);
      form.reset();
    } catch (err) {
      setCreateError({ message: err instanceof RangeError ? t("eventMgr.invalidDates") : NETWORK_ERROR, lock: null });
    } finally {
      setPending(false);
    }
  }

  async function rename(target: EventSummary, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name"));
    setError(null);
    try {
      const response = await fetch(`/api/events/${target.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, audienceLocale: data.get("audienceLocale") }),
      });
      if (!response.ok) {
        setError(await errorFrom(response));
        return;
      }
      const { event: saved } = (await response.json()) as { event: EventSummary };
      setEvents((list) => list.map((e) => (e.id === saved.id ? { ...e, ...saved } : e)));
      setRenaming(null);
    } catch {
      setError(NETWORK_ERROR);
    }
  }

  async function duplicate(target: EventSummary) {
    setError(null);
    try {
      const response = await fetch(`/api/events/${target.id}/duplicate`, { method: "POST" });
      if (!response.ok) {
        setError(await errorFrom(response));
        return;
      }
      const { event: saved } = (await response.json()) as { event: EventSummary };
      setEvents((list) => [...list, saved].sort(byStart));
      setCreated(saved);
    } catch {
      setError(NETWORK_ERROR);
    }
  }

  async function confirmDelete(target: EventSummary): Promise<string | null> {
    try {
      const response = await fetch(`/api/events/${target.id}`, { method: "DELETE" });
      if (!response.ok) return await errorFrom(response);
      setEvents((list) => list.filter((e) => e.id !== target.id));
      setCreated((c) => (c?.id === target.id ? null : c));
      setDeleting(null);
      return null;
    } catch {
      return NETWORK_ERROR;
    }
  }

  return (
    <div className="stack">
      <Card aria-labelledby="new-event-title">
        <h2 id="new-event-title">{t("eventMgr.newEvent")}</h2>
        <form onSubmit={createEvent} className="form-stack">
          <TextField label={t("eventMgr.eventName")} name="name" required maxLength={80} />
          <div className="form-pair">
            <TextField label={t("eventMgr.start")} name="startsAt" type="datetime-local" required />
            <TextField label={t("eventMgr.end")} name="endsAt" type="datetime-local" required />
          </div>
          <AudienceSelect defaultValue={hostLocale} />
          {templates.length > 0 && (
            <Select label={t("eventMgr.fromTemplate")} hint={t("eventMgr.fromTemplateHint")} name="templateId" defaultValue="">
              <option value="">{t("eventMgr.fromTemplateBlank")}</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} ({t(template.itemCount === 1 ? "templates.itemCount.one" : "templates.itemCount.other", { count: template.itemCount })})
                </option>
              ))}
            </Select>
          )}
          {createError && <PlanError error={createError} unlock={t("eventMgr.moreEvents")} />}
          <div>
            <Button type="submit" variant="primary" busy={pending}>
              {pending ? t("eventMgr.saving") : t("eventMgr.create")}
            </Button>
          </div>
        </form>
      </Card>

      {error && <InlineError>{error}</InlineError>}

      {created && (
        <div role="status" className="notice">
          <p className="notice-title">
            <strong>{created.name}</strong> {t("eventMgr.created")}
          </p>
          <p>
            {t("dash.joinCode")} <strong className="join-code">{created.joinCode}</strong>
          </p>
          <p>
            {t("eventMgr.joinLink")} <code>{joinUrl(created.joinCode)}</code>
          </p>
          {skipped > 0 && <p>{t(skipped === 1 ? "eventMgr.skipped.one" : "eventMgr.skipped.other", { count: skipped })}</p>}
        </div>
      )}

      <section aria-labelledby="events-title">
        <h2 id="events-title">{t("eventMgr.allEvents")}</h2>
        {events.length === 0 ? (
          <EmptyState title={t("eventMgr.emptyTitle")}>{t("eventMgr.emptyBody")}</EmptyState>
        ) : (
          <ul className="row-list">
            {events.map((e) => (
              <li key={e.id} className="event-row">
                <div className="event-main">
                  {renaming === e.id ? (
                    <form onSubmit={(ev) => rename(e, ev)} className="inline-form">
                      <TextField label={t("eventMgr.newName")} name="name" defaultValue={e.name} required maxLength={80} />
                      <AudienceSelect defaultValue={e.audienceLocale} />
                      <Button type="submit" variant="primary">{t("eventMgr.save")}</Button>
                      <Button onClick={() => setRenaming(null)}>{t("eventMgr.cancel")}</Button>
                    </form>
                  ) : (
                    <h3 className="event-name">{e.name}</h3>
                  )}
                  {e.lock && (
                    <div className="row-meta">
                      <Badge>{t("eventMgr.readOnly")}</Badge>
                    </div>
                  )}
                  <DeletionBadge event={e} retentionDays={retentionDays} now={now} />
                  <p className="row-meta">
                    {when(e.startsAt)} {t("eventMgr.to")} {when(e.endsAt)}
                  </p>
                  <div className="row-meta">
                    {t("dash.joinCode")} <Badge>{e.joinCode}</Badge>
                  </div>
                  <p className="row-meta">{t("language.audienceMeta", { language: t(`language.name.${e.audienceLocale}`) })}</p>
                  <div className="row-meta">
                    <LiveParticipantCount eventId={e.id} />
                  </div>
                </div>
                <div className="row-actions">
                  <Link href={`/dashboard/events/${e.id}`} className="ui-button" data-variant="primary">
                    {t("eventMgr.manage")}
                  </Link>
                  {e.lock ? (
                    <PlanHint lock={e.lock}>{t("eventMgr.unlock")}</PlanHint>
                  ) : (
                    <>
                      <Button variant="quiet" onClick={() => setRenaming(e.id)}>{t("eventMgr.rename")}</Button>
                      <Button variant="quiet" onClick={() => duplicate(e)}>{t("eventMgr.duplicate")}</Button>
                    </>
                  )}
                  <Button variant="quiet" onClick={() => setDeleting(e)}>{t("eventMgr.delete")}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <TypedConfirmDialog
        open={deleting !== null}
        title={t("eventMgr.deleteTitle")}
        body={t("eventMgr.deleteBody", { name: deleting?.name ?? "" })}
        expected={deleting?.name ?? ""}
        confirmLabel={t("eventMgr.deleteConfirm")}
        onConfirm={() => (deleting ? confirmDelete(deleting) : Promise.resolve(null))}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function DeletionBadge({ event, retentionDays, now }: { event: EventSummary; retentionDays: number | null; now: Date }) {
  const t = useT();
  const date = deletionDate({
    endsAt: new Date(event.endsAt),
    retentionDays,
    noticeSentAt: event.deletionNoticeSentAt ? new Date(event.deletionNoticeSentAt) : null,
    now,
  });
  if (!date) return null;
  return (
    <div className="row-meta">
      <Badge tone={deletionIsNear(date, now) ? "accent" : "neutral"}>{t("retention.badge", { date: formatDeletionDay(date) })}</Badge>
    </div>
  );
}

function AudienceSelect({ defaultValue }: { defaultValue: Locale }) {
  const t = useT();
  return (
    <Select label={t("language.audienceLabel")} hint={t("language.audienceHint")} name="audienceLocale" defaultValue={defaultValue}>
      {LOCALES.map((locale) => (
        <option key={locale} value={locale} lang={locale}>
          {t(`language.name.${locale}`)}
        </option>
      ))}
    </Select>
  );
}
