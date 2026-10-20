"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { LiveParticipantCount } from "@/components/live-participant-count";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { InlineError, TextField } from "@/components/ui/field";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";

export type EventSummary = {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  joinCode: string;
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

export function EventManager({ initialEvents }: { initialEvents: EventSummary[] }) {
  const t = useT();
  const [events, setEvents] = useState([...initialEvents].sort(byStart));
  const [created, setCreated] = useState<EventSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<EventSummary | null>(null);

  async function createEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          startsAt: new Date(String(data.get("startsAt"))).toISOString(),
          endsAt: new Date(String(data.get("endsAt"))).toISOString(),
        }),
      });
      if (!response.ok) {
        setError(await errorFrom(response));
        return;
      }
      const { event: saved } = (await response.json()) as { event: EventSummary };
      setEvents((list) => [...list, saved].sort(byStart));
      setCreated(saved);
      form.reset();
    } catch (err) {
      setError(err instanceof RangeError ? t("eventMgr.invalidDates") : NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  async function rename(target: EventSummary, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name"));
    setError(null);
    try {
      const response = await fetch(`/api/events/${target.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        setError(await errorFrom(response));
        return;
      }
      const { event: saved } = (await response.json()) as { event: EventSummary };
      setEvents((list) => list.map((e) => (e.id === saved.id ? saved : e)));
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

  async function confirmDelete(target: EventSummary) {
    setError(null);
    try {
      const response = await fetch(`/api/events/${target.id}`, { method: "DELETE" });
      if (!response.ok) {
        setError(await errorFrom(response));
        return;
      }
      setEvents((list) => list.filter((e) => e.id !== target.id));
      setCreated((c) => (c?.id === target.id ? null : c));
      setDeleting(null);
    } catch {
      setError(NETWORK_ERROR);
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
          {error && <InlineError>{error}</InlineError>}
          <div>
            <Button type="submit" variant="primary" busy={pending}>
              {pending ? t("eventMgr.saving") : t("eventMgr.create")}
            </Button>
          </div>
        </form>
      </Card>

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
                      <Button type="submit" variant="primary">{t("eventMgr.save")}</Button>
                      <Button onClick={() => setRenaming(null)}>{t("eventMgr.cancel")}</Button>
                    </form>
                  ) : (
                    <h3 className="event-name">{e.name}</h3>
                  )}
                  <p className="row-meta">
                    {new Date(e.startsAt).toLocaleString()} {t("eventMgr.to")} {new Date(e.endsAt).toLocaleString()}
                  </p>
                  <div className="row-meta">
                    {t("dash.joinCode")} <Badge>{e.joinCode}</Badge>
                  </div>
                  <div className="row-meta">
                    <LiveParticipantCount eventId={e.id} />
                  </div>
                </div>
                <div className="row-actions">
                  <Link href={`/dashboard/events/${e.id}`} className="ui-button" data-variant="primary">
                    {t("eventMgr.manage")}
                  </Link>
                  <Button variant="quiet" onClick={() => setRenaming(e.id)}>{t("eventMgr.rename")}</Button>
                  <Button variant="quiet" onClick={() => duplicate(e)}>{t("eventMgr.duplicate")}</Button>
                  <Button variant="quiet" onClick={() => setDeleting(e)}>{t("eventMgr.delete")}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={deleting !== null} title={t("eventMgr.deleteTitle")} onClose={() => setDeleting(null)}>
        <p>
          {t("eventMgr.deleteBody", { name: deleting?.name ?? "" })}
        </p>
        <div className="row-actions">
          <Button onClick={() => setDeleting(null)}>{t("eventMgr.cancel")}</Button>
          <Button variant="primary" onClick={() => deleting && confirmDelete(deleting)}>{t("eventMgr.deleteConfirm")}</Button>
        </div>
      </Dialog>
    </div>
  );
}
