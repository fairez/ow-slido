"use client";

import { useEffect, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { useT } from "@/lib/i18n/client";

/** Live count of connected participants for one event, pushed by the host's socket. */
export function LiveParticipantCount({ eventId }: { eventId: string }) {
  const t = useT();
  const { socket } = useEventSocket(eventId, "host");
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!socket) return;
    const onPresence = (payload: { count: number }) => setCount(payload.count);
    socket.on("presence", onPresence);
    return () => {
      socket.off("presence", onPresence);
    };
  }, [socket]);

  return (
    <div aria-live="polite">
      {t("liveCount.label")} <strong>{count}</strong>
    </div>
  );
}
