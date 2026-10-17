/** Db-free parser for the structured summary text, safe to import from client components. */
export type SummaryBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

const BULLET = /^\s*(?:[-*•])\s+(.*)$/;
const HEADING = /^\s*#{1,6}(?:\s+(.*))?$/;
const clean = (s: string) => s.replace(/\*\*|__/g, "").trim();

/**
 * The AI writes the summary as plain text: `## Heading` lines, `- ` bullets and short paragraphs.
 * Older or hand-edited summaries may be one paragraph; those render as a single paragraph block.
 */
export function parseSummary(text: string): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (list && list.length > 0) blocks.push({ type: "list", items: list });
    list = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    if (!line) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      const t = clean(heading[1] ?? "");
      if (t) blocks.push({ type: "heading", text: t });
    } else if (bullet) {
      flushParagraph();
      (list ??= []).push(clean(bullet[1]));
    } else {
      flushList();
      paragraph.push(clean(line));
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
