import { isProfane } from "@/lib/profanity";

export const KEYWORDS_MAX = 50;
export type AnalysisKeyword = { word: string; weight: number };

/** Lowercases, merges duplicates by summing weights, drops profanity, keeps the heaviest. */
export function normalizeKeywords(items: AnalysisKeyword[]): AnalysisKeyword[] {
  const merged = new Map<string, number>();
  for (const { word, weight } of items) {
    const w = word.toLowerCase().replace(/\s+/g, " ").trim();
    if (!w || w.length > 40 || isProfane(w) || !(weight > 0)) continue;
    merged.set(w, (merged.get(w) ?? 0) + weight);
  }
  return [...merged]
    .map(([word, weight]) => ({ word, weight }))
    .sort((a, b) => b.weight - a.weight || (a.word < b.word ? -1 : 1))
    .slice(0, KEYWORDS_MAX);
}

const STOP_WORDS = new Set(
  "a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours really get got like one also still much many lot lots thing things need needs want make makes".split(
    " ",
  ),
);

/** Word-frequency keywords with stop words, short words, numbers and profanity removed. */
export function fallbackKeywords(notes: { text: string }[]): AnalysisKeyword[] {
  const counts = new Map<string, number>();
  for (const n of notes) {
    for (const w of n.text.toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
      const word = w.replace(/^'+|'+$/g, "");
      if (word.length < 3 || /^\d+$/.test(word) || STOP_WORDS.has(word))
        continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return normalizeKeywords(
    [...counts].map(([word, weight]) => ({ word, weight })),
  );
}
