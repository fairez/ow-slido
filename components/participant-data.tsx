"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { InlineError } from "@/components/ui/field";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";
import { useLocale, useT } from "@/lib/i18n/client";
import { formatMoment } from "@/lib/format-date";

type Row = { id: string; name: string | null; joinedAt: string; contributions: number };
type Loaded = { participants: Row[]; total: number };

async function errorFrom(response: Response) {
  const body = await response.json().catch(() => null);
  return (body?.error as string | undefined) ?? SERVER_ERROR;
}

/** Mounted only while the dialog is open, so every opening starts with a fresh list. */
function Body({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Row | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/events/${eventId}/participants`)
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) return setError(await errorFrom(response));
        setData((await response.json()) as Loaded);
      })
      .catch(() => !cancelled && setError(NETWORK_ERROR));
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  // A new step starts at its heading so a keyboard or screen reader user lands on it.
  useEffect(() => {
    if (picked) heading.current?.focus();
  }, [picked]);

  const label = (row: Row, index: number) => row.name ?? t("participantData.anonymous", { number: index + 1 });

  async function erase(row: Row, name: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/events/${eventId}/participants/${row.id}/data`, { method: "DELETE" });
      if (!response.ok) {
        setError(await errorFrom(response));
        return;
      }
      setData((current) =>
        current && { total: current.total - 1, participants: current.participants.filter((p) => p.id !== row.id) },
      );
      setDone(name);
      setPicked(null);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  if (picked && data) {
    const name = label(picked, data.participants.findIndex((p) => p.id === picked.id));
    return (
      <div className="form-stack">
        <h3 ref={heading} tabIndex={-1} className="dialog-step">{t("participantData.confirmTitle", { name })}</h3>
        <p>{t(picked.contributions === 1 ? "participantData.confirmBody.one" : "participantData.confirmBody.other", { count: picked.contributions })}</p>
        {error && <InlineError>{error}</InlineError>}
        <div className="row-actions">
          <Button onClick={() => { setPicked(null); setError(null); }}>{t("participantData.back")}</Button>
          <Button variant="primary" aria-busy={pending || undefined} onClick={() => erase(picked, name)}>
            {t("participantData.confirm")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="form-stack">
      <p>{t("participantData.lead")}</p>
      {done !== null && <p role="status" className="row-meta">{t("participantData.deleted", { name: done })}</p>}
      {error && <InlineError>{error}</InlineError>}
      {data === null && !error && <p role="status" className="row-meta">{t("participantData.loading")}</p>}
      {data?.participants.length === 0 && <p role="status">{t("participantData.empty")}</p>}
      {data && data.participants.length > 0 && (
        <ul className="row-list participant-list">
          {data.participants.map((row, index) => {
            const name = label(row, index);
            return (
              <li key={row.id} className="participant-row">
                <div className="event-main">
                  <h3 className="event-name">{name}</h3>
                  <p className="row-meta">
                    {t("participantData.joined", { time: formatMoment(row.joinedAt, locale) })} ·{" "}
                    {t(row.contributions === 1 ? "participantData.contributions.one" : "participantData.contributions.other", { count: row.contributions })}
                  </p>
                </div>
                <Button aria-label={t("participantData.deleteFor", { name })} onClick={() => setPicked(row)}>
                  {t("participantData.delete")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {data && data.total > data.participants.length && (
        <p className="row-meta">{t("participantData.truncated", { shown: data.participants.length, total: data.total })}</p>
      )}
      <div className="row-actions">
        <Button onClick={onClose}>{t("participantData.close")}</Button>
      </div>
    </div>
  );
}

/** Event page section: erase one participant's data on request. */
export function ParticipantData({ eventId }: { eventId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <section className="participant-data" aria-labelledby="participant-data-title">
      <h2 id="participant-data-title">{t("participantData.title")}</h2>
      <p className="row-meta">{t("participantData.intro")}</p>
      <div className="row-actions">
        <Button onClick={() => setOpen(true)}>{t("participantData.open")}</Button>
      </div>
      <Dialog open={open} title={t("participantData.dialogTitle")} onClose={() => setOpen(false)}>
        <Body eventId={eventId} onClose={() => setOpen(false)} />
      </Dialog>
    </section>
  );
}
