"use client";

import { useEffect, useState } from "react";
import { InlineError } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";
import type { Standing } from "@/lib/leaderboard/standings";

const PODIUM_SIZE = 3;

/**
 * The final screen of a quiz: the top three of the event's cumulative scores. The steps rise one after the other
 * (third place first); under `prefers-reduced-motion` they simply appear. The DOM order is 1, 2, 3 for screen readers;
 * the wide layout puts first place in the middle with CSS.
 */
export function PresenterPodium({ eventId }: { eventId: string }) {
  const t = useT();
  const [standings, setStandings] = useState<Standing[] | "failed" | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/events/${eventId}/leaderboard?limit=${PODIUM_SIZE}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return ((await res.json()) as { standings: Standing[] }).standings;
      })
      .then((rows) => !cancelled && setStandings(rows))
      .catch(() => !cancelled && setStandings("failed"));
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (standings === null) {
    return (
      <p role="status" className="present-empty">
        {t("podium.loading")}
      </p>
    );
  }
  if (standings === "failed") return <InlineError>{t("podium.failed")}</InlineError>;
  if (standings.length === 0) {
    return (
      <p role="status" className="present-empty">
        {t("podium.empty")}
      </p>
    );
  }

  const points = (n: number) => t(n === 1 ? "quiz.points.one" : "quiz.points.other", { n });
  return (
    <ol className="podium" aria-label={t("podium.listLabel")}>
      {standings.map((s, i) => (
        <li key={i} className="podium-step" data-place={Math.min(PODIUM_SIZE, s.rank)} data-index={i}>
          <span className="podium-place">{t("podium.place", { n: s.rank })}</span>
          <span className="podium-name">{s.nickname ?? t("leaderboard.noName")}</span>
          <span className="podium-points">{points(s.points)}</span>
        </li>
      ))}
    </ol>
  );
}
