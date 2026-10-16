import { RatingChart } from "@/components/rating-chart";
import type { RatingResults } from "@/lib/rating";

/** Average, response count and distribution for the projector. */
export function PresenterRating({ results, closed }: { results: RatingResults; closed: boolean }) {
  const max = results.scale === "stars5" ? 5 : 10;
  return (
    <>
      <p style={{ fontSize: "5rem", fontWeight: 700, margin: "0 0 8px", lineHeight: 1 }}>
        {results.average === null ? "No ratings yet" : (
          <>
            {results.average.toFixed(1)} <span style={{ fontSize: "2rem", fontWeight: 400 }}>out of {max}</span>
          </>
        )}
      </p>
      <p style={{ fontSize: "2rem", margin: "0 0 24px" }}>
        {results.total} {results.total === 1 ? "response" : "responses"}
        {closed ? " (closed)" : ""}
      </p>
      <RatingChart results={results} large />
    </>
  );
}
