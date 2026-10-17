import type { AnalysisKeyword } from "@/lib/note-keywords";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const wordsOf = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
// Connector words do not need to appear in the notes for a name to count as taken from them.
const CONNECTORS = new Set(["dan", "atau", "yang", "dengan", "untuk", "dalam", "pada", "the", "and", "for", "with"]);

/** True when the name is a phrase from the text, or every meaningful word of it appears in the text. */
export function isAnchored(name: string, text: string): boolean {
  const t = norm(text);
  const n = norm(name);
  if (!n) return false;
  if (t.includes(n)) return true;
  const significant = wordsOf(n).filter((w) => !CONNECTORS.has(w));
  return significant.length > 0 && significant.every((w) => t.includes(w));
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Theme names should come from the participants' own words. Models still invent umbrella labels
 * ("Facilities"), so a name that is not found in the notes of its theme is replaced by the heaviest
 * keyword that is: one keyword, plus a second when it comes from a different note. If no keyword fits,
 * the model's name is kept. Never touches "Uncategorized" or empty themes.
 */
export function anchorCategoryNames<T extends { name: string; noteIds: string[] }>(
  categories: T[],
  textOf: (id: string) => string | undefined,
  keywords: AnalysisKeyword[],
  neutralName = "Uncategorized",
): T[] {
  const ranked = [...keywords]
    .map((k) => ({ word: norm(k.word), weight: k.weight }))
    .filter((k) => k.word.length >= 3)
    .sort((a, b) => b.weight - a.weight);

  return categories.map((c) => {
    if (norm(c.name) === norm(neutralName) || c.noteIds.length === 0) return c;
    const texts = c.noteIds.map((id) => norm(textOf(id) ?? "")).filter(Boolean);
    if (texts.length === 0 || isAnchored(c.name, texts.join("\n"))) return c;

    const present = ranked.filter((k) => texts.some((t) => t.includes(k.word)));
    const first = present[0];
    if (!first) return c;
    const second = present.find((k) => k !== first && texts.some((t) => t.includes(k.word) && !t.includes(first.word)));
    const name = [capitalize(first.word), second?.word].filter(Boolean).join(" & ").slice(0, 60);
    return { ...c, name };
  });
}
