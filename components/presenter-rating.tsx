import { RatingChart } from "@/components/rating-chart";
import type { RatingResults } from "@/lib/rating";

/** Average, response count and distribution for the projector. */
export function PresenterRating({ results, closed }: { results: RatingResults; closed: boolean }) {
  const max = results.scale === "stars5" ? 5 : 10;
  return (
    <>
      <p className="present-figure">
        {results.average === null ? (
          "No ratings yet"
        ) : (
          <>
            {results.average.toFixed(1)} <span className="present-figure-unit">out of {max}</span>
          </>
        )}
      </p>
      <p className="present-total">
        {results.total} {results.total === 1 ? "response" : "responses"}
        {closed ? " (closed)" : ""}
      </p>
      <RatingChart results={results} large />
    </>
  );
}
