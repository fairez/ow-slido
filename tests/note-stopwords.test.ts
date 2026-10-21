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

const INDONESIAN_SAMPLE = [
  { text: "Wifi sering terputus dan kopi kurang, tetapi materi bermanfaat" },
  { text: "Jeda terlalu sedikit dan wifi lambat karena banyak yang memakai" },
];
const ENGLISH_SAMPLE = [
  { text: "The wifi kept dropping and the coffee was cold, but the talks were useful" },
  { text: "There was too little time between sessions and the wifi is slow because of the crowd" },
];

test("an Indonesian event takes the Indonesian list: connectors go, content words stay", () => {
  const words = fallbackKeywords(INDONESIAN_SAMPLE, "id").map((k) => k.word);
  for (const w of ["dan", "tetapi", "karena", "yang"]) expect(words, w).not.toContain(w);
  for (const w of ["wifi", "kopi", "materi", "bermanfaat", "jeda", "terputus"]) expect(words, w).toContain(w);
  expect(fallbackKeywords(INDONESIAN_SAMPLE, "id").find((k) => k.word === "wifi")?.weight).toBe(2);
});

test("an English event takes the English list: connectors go, content words stay", () => {
  const words = fallbackKeywords(ENGLISH_SAMPLE, "en").map((k) => k.word);
  for (const w of ["the", "and", "was", "but", "because", "between"]) expect(words, w).not.toContain(w);
  for (const w of ["wifi", "coffee", "cold", "talks", "useful", "sessions", "crowd"]) expect(words, w).toContain(w);
});

test("a list only applies to its own language until the text is mixed", () => {
  // One Indonesian word in an English note is a loan or a name, not a mixed text.
  expect(isStopWord("dan", "en")).toBe(false);
  expect(isStopWord("the", "id")).toBe(false);
  expect(isStopWord("dan", "id")).toBe(true);
  expect(isStopWord("the", "en")).toBe(true);
  expect(fallbackKeywords([{ text: "Pak Dan gave the best talk about wifi" }], "en").map((k) => k.word)).toContain("dan");
  expect(trimStopWords("yang bermanfaat", "en")).toBe("yang bermanfaat");
  expect(trimStopWords("yang bermanfaat", "id")).toBe("bermanfaat");
});

test("mixed text uses both lists, whichever language the event has", () => {
  const mixed = [{ text: "Wifi lambat dan the coffee was cold, tetapi materi bermanfaat" }];
  for (const locale of ["id", "en"] as const) {
    const words = fallbackKeywords(mixed, locale).map((k) => k.word);
    for (const w of ["dan", "the", "was", "tetapi"]) expect(words, `${locale} ${w}`).not.toContain(w);
    for (const w of ["wifi", "lambat", "coffee", "cold", "materi", "bermanfaat"]) expect(words, `${locale} ${w}`).toContain(w);
  }
  expect(trimStopWords("the wifi and dan", "id")).toBe("wifi");
});

test("without a language both lists apply, as before", () => {
  const words = fallbackKeywords([...INDONESIAN_SAMPLE, ...ENGLISH_SAMPLE]).map((k) => k.word);
  for (const w of ["dan", "the", "and", "karena"]) expect(words, w).not.toContain(w);
  expect(isStopWord("dan")).toBe(true);
  expect(isStopWord("the")).toBe(true);
});

test("AI keywords are cleaned with the event's list", () => {
  const items = [
    { word: "the wifi", weight: 3 },
    { word: "yang wifi", weight: 2 },
  ];
  expect(normalizeKeywords(items, "en")).toEqual([
    { word: "wifi", weight: 3 },
    { word: "yang wifi", weight: 2 },
  ]);
  expect(normalizeKeywords(items, "id")).toEqual([
    { word: "the wifi", weight: 3 },
    { word: "wifi", weight: 2 },
  ]);
});
