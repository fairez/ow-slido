"use client";

import { useCallback, useEffect, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { InlineError } from "@/components/ui/field";
import type { HostResponse } from "@/lib/open-text";

/** Host-page list of an open-text interaction's responses, with highlight, hide and delete. */
export function OpenTextHostPanel({ eventId, interactionId, live }: { eventId: string; interactionId: string; live: boolean }) {
  const { socket } = useEventSocket(eventId, "host");
  const [responses, setResponses] = useState<HostResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/interactions/${interactionId}/responses`);
      if (!res.ok) return setError("Could not load responses.");
      setResponses(((await res.json()) as { responses: HostResponse[] }).responses);
      setError(null);
    } catch {
      setError("Could not load responses.");
    }
  }, [interactionId]);

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
      if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Something went wrong. Please try again.");
      else await load();
    } catch {
      setError("Network error. Please try again.");
    }
  }

  const patch = (id: string, change: { hidden?: boolean; highlighted?: boolean }) =>
    act(id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });

  return (
    <div className="response-panel">
      <h4>
        Responses{responses ? ` (${responses.length})` : ""}
        {live ? "" : ", closed"}
      </h4>
      {error && <InlineError>{error}</InlineError>}
      {responses && responses.length === 0 && <p className="row-meta">No responses yet. They appear here as people send them.</p>}
      {responses && responses.length > 0 && (
        <ul aria-label="Responses" className="row-list">
          {responses.map((r) => (
            <li key={r.id} className="response-row">
              <p className="response-text">{r.text}</p>
              {(r.highlighted || r.hidden) && (
                <p className="row-meta">
                  {r.highlighted ? "Highlighted" : ""}
                  {r.highlighted && r.hidden ? " · " : ""}
                  {r.hidden ? "Hidden from audience" : ""}
                </p>
              )}
              <div className="row-actions row-actions-quiet">
                {!r.hidden && (
                  <Button variant="quiet" aria-pressed={r.highlighted} onClick={() => patch(r.id, { highlighted: !r.highlighted })}>
                    {r.highlighted ? "Remove highlight" : "Highlight"}
                  </Button>
                )}
                <Button variant="quiet" onClick={() => patch(r.id, { hidden: !r.hidden })}>
                  {r.hidden ? "Show" : "Hide"}
                </Button>
                <Button variant="quiet" onClick={() => setDeleting(r.id)}>Delete</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={deleting !== null} title="Delete this response?" onClose={() => setDeleting(null)}>
        <p>The response is removed for everyone.</p>
        <div className="row-actions">
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              if (deleting) void act(deleting, { method: "DELETE" });
              setDeleting(null);
            }}
          >
            Delete response
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
