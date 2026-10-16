"use client";

import { useCallback, useEffect, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import type { HostResponse } from "@/lib/open-text";

const buttonStyle = { padding: "0 12px", font: "inherit", minHeight: 44 } as const;

/** Host-page list of an open-text interaction's responses, with highlight, hide and delete. */
export function OpenTextHostPanel({ eventId, interactionId, live }: { eventId: string; interactionId: string; live: boolean }) {
  const { socket } = useEventSocket(eventId, "host");
  const [responses, setResponses] = useState<HostResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div style={{ marginTop: 8 }}>
      <h3 style={{ fontSize: "1rem" }}>
        Responses{responses ? ` (${responses.length})` : ""}
        {live ? "" : ", closed"}
      </h3>
      {error && <p role="alert" style={{ color: "#b00020" }}>{error}</p>}
      {responses && responses.length === 0 && <p>No responses yet.</p>}
      {responses && responses.length > 0 && (
        <ul aria-label="Responses" style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
          {responses.map((r) => (
            <li key={r.id} style={{ border: "1px solid #ccc", padding: 8 }}>
              <p style={{ margin: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{r.text}</p>
              <p style={{ margin: "4px 0" }}>
                {r.highlighted ? "Highlighted" : ""}
                {r.highlighted && r.hidden ? " · " : ""}
                {r.hidden ? "Hidden from audience" : ""}
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {!r.hidden && (
                  <button type="button" aria-pressed={r.highlighted} onClick={() => patch(r.id, { highlighted: !r.highlighted })} style={buttonStyle}>
                    {r.highlighted ? "Remove highlight" : "Highlight"}
                  </button>
                )}
                <button type="button" onClick={() => patch(r.id, { hidden: !r.hidden })} style={buttonStyle}>
                  {r.hidden ? "Show" : "Hide"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm("Delete this response?")) void act(r.id, { method: "DELETE" });
                  }}
                  style={buttonStyle}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
