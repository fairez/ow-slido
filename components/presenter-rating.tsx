"use client";

import { RatingChart } from "@/components/rating-chart";
import { useT } from "@/lib/i18n/client";
import type { RatingResults } from "@/lib/rating";

/** Average, response count and distribution for the projector. */
export function PresenterRating({ results, closed }: { results: RatingResults; closed: boolean }) {
  const t = useT();
  const max = results.scale === "stars5" ? 5 : 10;
  return (
    <>
      <p className="present-figure">
        {results.average === null ? (
          t("presRating.none")
        ) : (
          <>
            {results.average.toFixed(1)} <span className="present-figure-unit">{t("presRating.outOf", { max })}</span>
          </>
        )}
      </p>
      <p className="present-total">
        {t(results.total === 1 ? "presRating.count.one" : "presRating.count.other", { n: results.total })}
        {closed ? t("presRating.closed") : ""}
      </p>
      <RatingChart results={results} large />
    </>
  );
}
