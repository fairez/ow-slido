import { parseSummary } from "@/lib/analysis-summary";

/** Renders the structured summary: headings, bullet lists and short paragraphs. */
export function AnalysisSummary({ text, className = "" }: { text: string; className?: string }) {
  const blocks = parseSummary(text);
  return (
    <div className={`summary-text ${className}`.trim()}>
      {blocks.map((block, i) =>
        block.type === "heading" ? (
          <h4 key={i} className="summary-heading">
            {block.text}
          </h4>
        ) : block.type === "list" ? (
          <ul key={i} className="summary-list">
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{block.text}</p>
        ),
      )}
    </div>
  );
}
