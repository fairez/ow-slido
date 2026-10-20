"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "unauthorized";

/**
 * Connects to the event's realtime room. Reconnects automatically and starts on long-polling,
 * upgrading to WebSocket when available, so it still works behind proxies that block WebSockets.
 */
export function useEventSocket(
  eventId: string,
  role: "participant" | "host" | "moderator" = "participant",
  enabled = true,
) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    if (!enabled) return;
    const s = io({
      path: "/socket.io",
      auth: { eventId, role },
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionDelayMax: 5000,
    });
    s.on("connect", () => setStatus("connected"));
    s.on("disconnect", () => setStatus("disconnected"));
    s.on("connect_error", (err) => setStatus(err.message === "unauthorized" ? "unauthorized" : "disconnected"));
    s.io.on("reconnect_attempt", () => setStatus((cur) => (cur === "unauthorized" ? cur : "connecting")));
    // Deferred so the effect body doesn't set state synchronously.
    queueMicrotask(() => setSocket(s));
    return () => {
      s.disconnect();
      setSocket((cur) => (cur === s ? null : cur));
    };
  }, [eventId, role, enabled]);

  return { socket, status };
}
