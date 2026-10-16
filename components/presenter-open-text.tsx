import type { PublicResponse } from "@/lib/open-text";

/** Responses for the projector, newest first; highlighted ones get a heavier border and a label. */
export function PresenterOpenText({ responses, closed }: { responses: PublicResponse[]; closed: boolean }) {
  const ordered = [...responses].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <p style={{ fontSize: "2rem", margin: "0 0 16px" }}>
        {responses.length} {responses.length === 1 ? "response" : "responses"}
        {closed ? " (closed)" : ""}
      </p>
      {ordered.length === 0 ? (
        <p role="status" style={{ fontSize: "2rem" }}>
          No responses yet
        </p>
      ) : (
        <ul aria-label="Responses" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 16 }}>
          {ordered.map((r) => (
            <li
              key={r.id}
              style={{
                padding: 16,
                border: r.highlighted ? "4px solid #ffd400" : "2px solid #fff",
                overflowWrap: "anywhere",
                minWidth: 0,
              }}
            >
              {r.highlighted && <p style={{ margin: "0 0 8px", fontSize: "1rem", fontWeight: 700, color: "#ffd400" }}>Highlighted</p>}
              <p
                style={{
                  margin: 0,
                  fontSize: r.highlighted ? "2.25rem" : "1.75rem",
                  fontWeight: r.highlighted ? 700 : 400,
                  lineHeight: 1.3,
                  whiteSpace: "pre-wrap",
                }}
              >
                {r.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
