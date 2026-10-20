"use client";

import { useT } from "@/lib/i18n/client";
import type { Standing } from "@/lib/leaderboard/standings";

/** Ranked rows: rank number, nickname (or a fallback for someone who never picked one) and points. Tied rows print the same rank. */
export function LeaderboardList({ standings }: { standings: Standing[] }) {
  const t = useT();
  const points = (n: number) => t(n === 1 ? "quiz.points.one" : "quiz.points.other", { n });
  return (
    <ul className="leaderboard" aria-label={t("leaderboard.label")}>
      {standings.map((s, i) => (
        <li key={i} className="leaderboard-row">
          <span className="leaderboard-rank">{s.rank}</span>
          <span className="leaderboard-name">{s.nickname ?? t("leaderboard.noName")}</span>
          <span className="leaderboard-points">{points(s.points)}</span>
        </li>
      ))}
    </ul>
  );
}
