"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Returns a stable function that runs `fn` once after calls stop for `waitMs`. A burst of realtime
 * events (fifty notes arriving at once) then causes one refetch instead of fifty.
 */
export function useCoalesced(fn: () => void, waitMs = 400) {
  const latest = useRef(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latest.current = fn;
  }, [fn]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current();
    }, waitMs);
  }, [waitMs]);
}
