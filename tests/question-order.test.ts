import { expect, test } from "vitest";
import { applyQuestionEvent, orderQuestions } from "@/lib/question-order";
import type { PublicQuestion } from "@/lib/question-types";

const q = (id: string, over: Partial<PublicQuestion> = {}): PublicQuestion => ({
  id,
  text: `Question ${id}`,
  authorName: null,
  answered: false,
  pinned: false,
  createdAt: `2026-11-01T10:0${id}:00.000Z`,
  upvotes: 0,
  upvoted: false,
  ...over,
});

const ids = (list: PublicQuestion[]) => list.map((x) => x.id);

test("pinned first, answered last, then upvotes (popular) with newest breaking ties", () => {
  const list = [
    q("1", { upvotes: 5 }),
    q("2", { upvotes: 9, answered: true }),
    q("3", { upvotes: 5 }),
    q("4", { pinned: true, upvotes: 0 }),
    q("5", { upvotes: 1 }),
  ];
  expect(ids(orderQuestions(list, "popular"))).toEqual(["4", "3", "1", "5", "2"]);
});

test("recent ordering ignores upvotes but still pins first and answered last", () => {
  const list = [q("1", { upvotes: 9 }), q("2"), q("3", { answered: true }), q("4", { pinned: true })];
  expect(ids(orderQuestions(list, "recent"))).toEqual(["4", "2", "1", "3"]);
});

test("ordering does not change the input", () => {
  const list = [q("1"), q("2", { upvotes: 3 })];
  orderQuestions(list, "popular");
  expect(ids(list)).toEqual(["1", "2"]);
});

test("added questions are appended once; a repeated add changes nothing", () => {
  const first = applyQuestionEvent([], { name: "question:added", question: q("1") });
  expect(ids(first)).toEqual(["1"]);
  expect(applyQuestionEvent(first, { name: "question:added", question: q("1") })).toBe(first);
});

test("votes, pin/answer updates and removal touch only the named question", () => {
  const list = [q("1"), q("2")];
  expect(applyQuestionEvent(list, { name: "question:votes", questionId: "2", upvotes: 7 }).map((x) => x.upvotes)).toEqual([0, 7]);
  const updated = applyQuestionEvent(list, { name: "question:updated", questionId: "1", pinned: true, answered: true });
  expect(updated[0]).toMatchObject({ pinned: true, answered: true });
  expect(updated[1]).toMatchObject({ pinned: false, answered: false });
  expect(ids(applyQuestionEvent(list, { name: "question:removed", questionId: "1" }))).toEqual(["2"]);
  expect(ids(applyQuestionEvent(list, { name: "question:removed", questionId: "zzz" }))).toEqual(["1", "2"]);
});
