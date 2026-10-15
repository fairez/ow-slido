"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import type { LiveInteraction } from "@/lib/live-view";

type StateChanged = { interactionId: string; state: "draft" | "live" | "closed" };

/** Participant's live area: shows the live poll, "Waiting for the host", or "Voting closed". */
export function LiveView({ eventId, initial }: { eventId: string; initial: LiveInteraction | null }) {
  const { socket } = useEventSocket(eventId, "participant");
  const [current, setCurrent] = useState<LiveInteraction | null>(initial);
  const currentId = useRef<string | null>(initial?.id ?? null);

  const apply = useCallback((next: LiveInteraction | null) => {
    currentId.current = next?.id ?? null;
    setCurrent(next);
  }, []);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/live`);
      if (!res.ok) return;
      const body = (await res.json()) as { interaction: LiveInteraction | null };
      // A closed poll stays on screen as "Voting closed" until the host starts another one.
      if (body.interaction === null) setCurrent((cur) => (cur?.state === "closed" ? cur : null));
      else apply(body.interaction);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [eventId, apply]);

  useEffect(() => {
    if (!socket) return;
    const onChange = (msg: StateChanged) => {
      if (msg.state === "closed" && msg.interactionId === currentId.current) {
        setCurrent((cur) => (cur ? { ...cur, state: "closed" } : cur));
      } else if (msg.state === "live") {
        void refetch();
      }
    };
    // Messages missed while disconnected are not replayed, so resync on every (re)connect.
    const onConnect = () => void refetch();
    socket.on("state-changed", onChange);
    socket.on("connect", onConnect);
    return () => {
      socket.off("state-changed", onChange);
      socket.off("connect", onConnect);
    };
  }, [socket, refetch]);

  if (!current) return <p role="status">Waiting for the host…</p>;

  return (
    <section aria-labelledby="live-title">
      <h2 id="live-title">{current.title}</h2>
      {current.state === "closed" ? (
        <p role="status">Voting closed</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
          {current.options.map((o) => (
            <li
              key={o.id}
              style={{ minHeight: 44, display: "flex", alignItems: "center", padding: "0 12px", border: "1px solid #888", borderRadius: 8 }}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
