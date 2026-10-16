import type { PublicResponse } from "@/lib/open-text";

/** Responses for the projector, newest first; highlighted ones get an accent border and a label. */
export function PresenterOpenText({ responses, closed }: { responses: PublicResponse[]; closed: boolean }) {
  const ordered = [...responses].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <p className="present-total">
        {responses.length} {responses.length === 1 ? "response" : "responses"}
        {closed ? " (closed)" : ""}
      </p>
      {ordered.length === 0 ? (
        <p role="status" className="present-empty">
          No responses yet
        </p>
      ) : (
        <ul aria-label="Responses" className="present-cards">
          {ordered.map((r) => (
            <li key={r.id} className="present-card" data-highlight={r.highlighted || undefined}>
              {r.highlighted && <p className="present-card-label">Highlighted</p>}
              <p className="present-card-text">{r.text}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
