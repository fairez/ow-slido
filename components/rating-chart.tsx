import type { RatingResults } from "@/lib/rating";

/** Distribution of ratings, one row per value, with the count and share printed beside each bar. */
export function RatingChart({ results, large = false }: { results: RatingResults; large?: boolean }) {
  const max = Math.max(1, ...results.distribution);
  const size = large ? "1.75rem" : "1rem";
  return (
    <ol aria-label="Rating distribution" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: large ? 12 : 6 }}>
      {results.distribution.map((count, i) => {
        const percent = results.total > 0 ? Math.round((count / results.total) * 100) : 0;
        return (
          <li
            key={i}
            style={{ display: "grid", gridTemplateColumns: "2.5ch 1fr auto", alignItems: "center", gap: 12, fontSize: size }}
          >
            <span style={{ fontWeight: 700 }}>{i + 1}</span>
            <span aria-hidden="true" style={{ display: "block", height: large ? 28 : 16, border: "1px solid var(--border, #8a8178)" }}>
              <span style={{ display: "block", height: "100%", width: `${(count / max) * 100}%`, background: "var(--ink, currentColor)" }} />
            </span>
            <span style={{ minWidth: "8ch", textAlign: "right" }}>
              {count} ({percent}%)
            </span>
          </li>
        );
      })}
    </ol>
  );
}
