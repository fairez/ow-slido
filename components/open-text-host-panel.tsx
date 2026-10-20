"use client";

import { useCallback, useEffect, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { InlineError } from "@/components/ui/field";
import type { HostResponse } from "@/lib/open-text";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";

/** Host-page list of an open-text interaction's responses, with highlight, hide and delete. */
export function OpenTextHostPanel({ eventId, interactionId, live }: { eventId: string; interactionId: string; live: boolean }) {
  const t = useT();
  const { socket } = useEventSocket(eventId, "host");
  const [responses, setResponses] = useState<HostResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/interactions/${interactionId}/responses`);
      if (!res.ok) return setError(t("openTextHost.loadError"));
      setResponses(((await res.json()) as { responses: HostResponse[] }).responses);
      setError(null);
    } catch {
      setError(t("openTextHost.loadError"));
    }
  }, [interactionId, t]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onChange = () => void load();
    socket.on("response:added", onChange);
    socket.on("response:updated", onChange);
    socket.on("response:removed", onChange);
    socket.on("connect", onChange);
    return () => {
      socket.off("response:added", onChange);
      socket.off("response:updated", onChange);
      socket.off("response:removed", onChange);
      socket.off("connect", onChange);
    };
  }, [socket, load]);

  async function act(id: string, init: RequestInit) {
    setError(null);
    try {
      const res = await fetch(`/api/responses/${id}`, init);
      if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? SERVER_ERROR);
      else await load();
    } catch {
      setError(NETWORK_ERROR);
    }
  }

  const patch = (id: string, change: { hidden?: boolean; highlighted?: boolean }) =>
    act(id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });

  return (
    <div className="response-panel">
      <h4>
        {responses ? t("openTextHost.titleCount", { n: responses.length }) : t("openTextHost.title")}
        {live ? "" : t("openTextHost.closedSuffix")}
      </h4>
      {error && <InlineError>{error}</InlineError>}
      {responses && responses.length === 0 && <p className="row-meta">{t("openTextHost.empty")}</p>}
      {responses && responses.length > 0 && (
        <ul aria-label={t("openTextHost.list")} className="row-list">
          {responses.map((r) => (
            <li key={r.id} className="response-row">
              <p className="response-text">{r.text}</p>
              {(r.highlighted || r.hidden) && (
                <p className="row-meta">
                  {r.highlighted ? t("openTextHost.highlighted") : ""}
                  {r.highlighted && r.hidden ? " · " : ""}
                  {r.hidden ? t("openTextHost.hidden") : ""}
                </p>
              )}
              <div className="row-actions row-actions-quiet">
                {!r.hidden && (
                  <Button variant="quiet" aria-pressed={r.highlighted} onClick={() => patch(r.id, { highlighted: !r.highlighted })}>
                    {r.highlighted ? t("openTextHost.removeHighlight") : t("openTextHost.highlight")}
                  </Button>
                )}
                <Button variant="quiet" onClick={() => patch(r.id, { hidden: !r.hidden })}>
                  {r.hidden ? t("openTextHost.show") : t("openTextHost.hide")}
                </Button>
                <Button variant="quiet" onClick={() => setDeleting(r.id)}>{t("openTextHost.delete")}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={deleting !== null} title={t("openTextHost.deleteTitle")} onClose={() => setDeleting(null)}>
        <p>{t("openTextHost.deleteBody")}</p>
        <div className="row-actions">
          <Button onClick={() => setDeleting(null)}>{t("openTextHost.cancel")}</Button>
          <Button
            variant="primary"
            onClick={() => {
              if (deleting) void act(deleting, { method: "DELETE" });
              setDeleting(null);
            }}
          >
            {t("openTextHost.deleteConfirm")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
