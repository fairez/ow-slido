"use client";

import { useCallback, useEffect, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import type { PresenterState } from "@/lib/presenter";

type Counts = { interactionId: string; counts: Record<string, number>; total: number };

/** Full-screen results for the live poll; stays current from `poll:counts` and `state-changed`. */
export function PresenterView({ eventId, initial }: { eventId: string; initial: PresenterState | null }) {
  const { socket } = useEventSocket(eventId, "host");
  const [poll, setPoll] = useState<PresenterState | null>(initial);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/present`);
      if (!res.ok) return;
      setPoll(((await res.json()) as { interaction: PresenterState | null }).interaction);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [eventId]);

  useEffect(() => {
    if (!socket) return;
    const onCounts = (msg: Counts) =>
      setPoll((cur) => (cur && cur.id === msg.interactionId ? { ...cur, counts: msg.counts, total: msg.total } : cur));
    // Start or close changes which poll is live; the payload has no content, so resync.
    const onChange = () => void refetch();
    // Messages missed while disconnected are not replayed.
    const onConnect = () => void refetch();
    socket.on("poll:counts", onCounts);
    socket.on("state-changed", onChange);
    socket.on("connect", onConnect);
    return () => {
      socket.off("poll:counts", onCounts);
      socket.off("state-changed", onChange);
      socket.off("connect", onConnect);
    };
  }, [socket, refetch]);

  if (!poll) {
    return (
      <p role="status" style={{ fontSize: "3rem", fontWeight: 700 }}>
        No live interaction
      </p>
    );
  }

  return (
    <section aria-labelledby="present-title">
      <h1 id="present-title" style={{ fontSize: "3rem", margin: "0 0 24px" }}>
        {poll.title}
      </h1>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 20 }}>
        {poll.options.map((o) => {
          const count = poll.counts[o.id] ?? 0;
          const percent = poll.total > 0 ? Math.round((count / poll.total) * 100) : 0;
          return (
            <li key={o.id} style={{ fontSize: "2rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, fontWeight: 700 }}>
                <span>{o.label}</span>
                <span>
                  {count} ({percent}%)
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={o.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                style={{ height: 28, background: "#333", border: "2px solid #fff" }}
              >
                <div style={{ width: `${percent}%`, height: "100%", background: "#ffd400" }} />
              </div>
            </li>
          );
        })}
      </ul>
      <p style={{ fontSize: "2rem", marginTop: 24 }}>Total votes: {poll.total}</p>
    </section>
  );
}
