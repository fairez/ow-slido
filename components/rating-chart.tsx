import type { RatingResults } from "@/lib/rating";

/** Distribution of ratings, one row per value, with the count and share printed beside each bar. */
export function RatingChart({ results, large = false }: { results: RatingResults; large?: boolean }) {
  const max = Math.max(1, ...results.distribution);
  const lead = Math.max(0, ...results.distribution);
  return (
    <ol aria-label="Rating distribution" className="rating-chart" data-large={large || undefined}>
      {results.distribution.map((count, i) => {
        const percent = results.total > 0 ? Math.round((count / results.total) * 100) : 0;
        return (
          <li key={i}>
            <span className="rating-chart-value">{i + 1}</span>
            <span aria-hidden="true" className="present-track">
              <span className="present-fill" data-leading={count > 0 && count === lead} style={{ width: `${(count / max) * 100}%` }} />
            </span>
            <span className="rating-chart-count">
              {count} ({percent}%)
            </span>
          </li>
        );
      })}
    </ol>
  );
}
