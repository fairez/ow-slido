import { expect, test } from "vitest";
import { anchorCategoryNames, isAnchored } from "@/lib/note-category-names";

const texts: Record<string, string> = {
  a: "Jeda istirahat terlalu sedikit, kami butuh coffee break setiap jam",
  b: "Materi sangat bermanfaat dan mudah diikuti",
  c: "Wifi sering terputus saat sesi demo",
  d: "Kopi dan snack kurang, tolong ditambah",
};
const textOf = (id: string) => texts[id];
const keywords = [
  { word: "wifi", weight: 3 },
  { word: "snack", weight: 2 },
  { word: "materi", weight: 4 },
  { word: "jeda", weight: 5 },
];

test("a name counts as taken from the notes when it is a phrase from them or all its words are", () => {
  expect(isAnchored("Jeda istirahat", texts.a)).toBe(true);
  expect(isAnchored("Materi", texts.b)).toBe(true);
  expect(isAnchored("Wifi dan sesi", texts.c)).toBe(true);
  expect(isAnchored("Fasilitas", `${texts.c}\n${texts.d}`)).toBe(false);
  expect(isAnchored("", texts.a)).toBe(false);
});

test("an invented umbrella label is replaced by the heaviest keyword found in the theme's notes", () => {
  const out = anchorCategoryNames(
    [
      { name: "Fasilitas", description: "d", noteIds: ["c", "d"] },
      { name: "Materi", description: "d", noteIds: ["b"] },
    ],
    textOf,
    keywords,
  );
  expect(out.map((c) => c.name)).toEqual(["Wifi & snack", "Materi"]);
  expect(out[0].description).toBe("d");
  expect(out[0].noteIds).toEqual(["c", "d"]);
});

test("a single-note theme gets one keyword, not two", () => {
  const out = anchorCategoryNames([{ name: "Konektivitas", description: "d", noteIds: ["c"] }], textOf, keywords);
  expect(out[0].name).toBe("Wifi");
});

test("keeps the model's name when no keyword is found in the notes, and leaves Uncategorized and empty themes alone", () => {
  const out = anchorCategoryNames(
    [
      { name: "Lain-lain", description: "d", noteIds: ["b"] },
      { name: "Uncategorized", description: "d", noteIds: ["c"] },
      { name: "Kosong", description: "d", noteIds: [] },
    ],
    textOf,
    [{ word: "wifi", weight: 3 }],
  );
  expect(out.map((c) => c.name)).toEqual(["Lain-lain", "Uncategorized", "Kosong"]);
});

test("ignores unknown note ids", () => {
  const out = anchorCategoryNames([{ name: "Fasilitas", description: "d", noteIds: ["zzz"] }], textOf, keywords);
  expect(out[0].name).toBe("Fasilitas");
});
