"use client";

import { useT } from "@/lib/i18n/client";
import type { RankingResults } from "@/lib/ranking";

/** Options best first for the projector: the rank and the score are printed, the bar only repeats them. */
export function PresenterRanking({ results, closed }: { results: RankingResults; closed: boolean }) {
  const t = useT();
  const top = Math.max(0, ...results.options.map((o) => o.score));
  return (
    <>
      <ol aria-label={t("presRanking.label")} className="present-bars present-ranking">
        {results.options.map((o) => (
          <li key={o.id}>
            <div className="present-bar-head">
              <span>
                <span className="present-rank">{t("presRanking.rank", { rank: o.rank })}</span> {o.text}
              </span>
              <span>{t(o.score === 1 ? "presRanking.points.one" : "presRanking.points.other", { n: o.score })}</span>
            </div>
            <span aria-hidden="true" className="present-track">
              <span className="present-fill" data-leading={o.rank === 1 && o.score > 0} style={{ width: `${top > 0 ? (o.score / top) * 100 : 0}%` }} />
            </span>
          </li>
        ))}
      </ol>
      <p className="present-total">
        {t(results.total === 1 ? "presRanking.count.one" : "presRanking.count.other", { n: results.total })}
        {closed ? t("presRanking.closed") : ""}
      </p>
    </>
  );
}
