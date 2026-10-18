import { isProfane } from "@/lib/profanity";
import { isStopWord, trimStopWords } from "@/lib/note-stopwords";

export const KEYWORDS_MAX = 50;
export type AnalysisKeyword = { word: string; weight: number };

/** Lowercases, merges duplicates by summing weights, drops profanity and stop words (Indonesian and English), keeps the heaviest. */
export function normalizeKeywords(items: AnalysisKeyword[]): AnalysisKeyword[] {
  const merged = new Map<string, number>();
  for (const { word, weight } of items) {
    const w = trimStopWords(word.toLowerCase().replace(/\s+/g, " ").trim());
    if (!w || w.length > 40 || isProfane(w) || !(weight > 0)) continue;
    merged.set(w, (merged.get(w) ?? 0) + weight);
  }
  return [...merged]
    .map(([word, weight]) => ({ word, weight }))
    .sort((a, b) => b.weight - a.weight || (a.word < b.word ? -1 : 1))
    .slice(0, KEYWORDS_MAX);
}

/** Word-frequency keywords with stop words, short words, numbers and profanity removed. */
export function fallbackKeywords(notes: { text: string }[]): AnalysisKeyword[] {
  const counts = new Map<string, number>();
  for (const n of notes) {
    for (const w of n.text.toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
      const word = w.replace(/^'+|'+$/g, "");
      if (word.length < 3 || /^\d+$/.test(word) || isStopWord(word))
        continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return normalizeKeywords(
    [...counts].map(([word, weight]) => ({ word, weight })),
  );
}
