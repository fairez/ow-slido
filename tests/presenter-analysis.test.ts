import { expect, test } from "vitest";
import {
  categoryNotes,
  parseCategories,
  parseKeywords,
} from "@/components/presenter-analysis";
import type { PublicNote } from "@/lib/shared-notes";

const note = (
  id: string,
  upvotes: number,
  createdAt = "2026-10-16T10:00:00Z",
): PublicNote => ({
  id,
  interactionId: "i",
  text: id,
  authorName: null,
  pinned: false,
  createdAt,
  upvotes,
});

test("category notes are ordered by upvotes and skip notes that no longer exist", () => {
  const cat = { name: "A", description: "", noteIds: ["a", "gone", "b", "c"] };
  const notes = [
    note("a", 1),
    note("b", 5),
    note("c", 1, "2026-10-16T11:00:00Z"),
  ];
  expect(categoryNotes(cat, notes).map((n) => n.id)).toEqual(["b", "c", "a"]);
});

test("parsers ignore malformed stored data", () => {
  expect(parseCategories(null)).toEqual([]);
  expect(
    parseCategories([{ name: "A", noteIds: ["x", 3] }, { nope: 1 }]),
  ).toEqual([{ name: "A", description: "", noteIds: ["x"] }]);
  expect(parseKeywords([{ word: "w", weight: 2 }, { word: 1 }])).toEqual([
    { word: "w", weight: 2 },
  ]);
});
