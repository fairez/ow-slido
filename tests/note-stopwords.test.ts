import { expect, test } from "vitest";
import { fallbackKeywords, normalizeKeywords } from "@/lib/note-keywords";
import { isIndonesianStopWord, isStopWord, trimStopWords } from "@/lib/note-stopwords";

test("Indonesian conjunctions, prepositions and fillers are stop words, in any case", () => {
  for (const w of ["dan", "Atau", "yang", "tetapi", "karena", "sehingga", "di", "ke", "dari", "untuk", "dengan", "saya", "kami", "ini", "itu"]) {
    expect(isIndonesianStopWord(w), w).toBe(true);
  }
});

test("words that carry feedback stay: negations, evaluations and topics", () => {
  for (const w of ["tidak", "kurang", "belum", "terlalu", "perlu", "bermanfaat", "wifi", "jeda", "materi", "kopi", "diskusi", "lebih"]) {
    expect(isIndonesianStopWord(w) && w !== "lebih", w).toBe(false);
  }
  expect(isStopWord("wifi")).toBe(false);
  expect(isStopWord("the")).toBe(true);
});

test("trimStopWords cuts them from the ends of a phrase only", () => {
  expect(trimStopWords("yang bermanfaat")).toBe("bermanfaat");
  expect(trimStopWords("tanya dan jawab")).toBe("tanya dan jawab");
  expect(trimStopWords("di dalam untuk")).toBe("");
  expect(trimStopWords("coffee break")).toBe("coffee break");
});

test("AI keywords lose stop words, merge after trimming, and keep real phrases", () => {
  const out = normalizeKeywords([
    { word: "dan", weight: 9 },
    { word: "yang", weight: 8 },
    { word: "Wifi", weight: 3 },
    { word: "yang wifi", weight: 1 },
    { word: "untuk", weight: 7 },
    { word: "tanya jawab", weight: 2 },
    { word: "di sini", weight: 4 },
  ]);
  expect(out).toEqual([
    { word: "wifi", weight: 4 },
    { word: "sini", weight: 4 },
    { word: "tanya jawab", weight: 2 },
  ].sort((a, b) => b.weight - a.weight || (a.word < b.word ? -1 : 1)));
  expect(out.map((k) => k.word)).not.toContain("dan");
});

test("the frequency fallback ignores Indonesian connectors", () => {
  const out = fallbackKeywords([
    { text: "Wifi sering terputus dan kopi kurang, tetapi materi bermanfaat" },
    { text: "Jeda terlalu sedikit dan wifi lambat karena banyak yang memakai" },
    { text: "Saya ingin lebih banyak diskusi untuk semua peserta" },
  ]);
  const words = out.map((k) => k.word);
  for (const w of ["dan", "yang", "tetapi", "karena", "untuk", "saya"]) expect(words).not.toContain(w);
  expect(words).toContain("wifi");
  expect(out.find((k) => k.word === "wifi")?.weight).toBe(2);
});
