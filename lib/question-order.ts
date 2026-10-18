import type { PublicQuestion } from "@/lib/question-types";

/** Db-free helpers for the presenter's Q&A screen, safe to import from client components. */
export type QaSort = "popular" | "recent";

/**
 * Pinned questions first, answered ones last, and the rest by upvotes (popular) or newest. Ties
 * always fall back to newest so the order never jumps around between equal questions.
 */
export function orderQuestions(list: PublicQuestion[], sort: QaSort): PublicQuestion[] {
  return [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(a.answered) - Number(b.answered) ||
      (sort === "popular" ? b.upvotes - a.upvotes : 0) ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

export type QuestionEvent =
  | { name: "question:added"; question: PublicQuestion }
  | { name: "question:votes"; questionId: string; upvotes: number }
  | { name: "question:updated"; questionId: string; pinned: boolean; answered: boolean }
  | { name: "question:removed"; questionId: string };

/** Applies one realtime message to the list; unknown ids and repeated adds change nothing. */
export function applyQuestionEvent(list: PublicQuestion[], event: QuestionEvent): PublicQuestion[] {
  switch (event.name) {
    case "question:added":
      return list.some((q) => q.id === event.question.id) ? list : [...list, event.question];
    case "question:votes":
      return list.map((q) => (q.id === event.questionId ? { ...q, upvotes: event.upvotes } : q));
    case "question:updated":
      return list.map((q) => (q.id === event.questionId ? { ...q, pinned: event.pinned, answered: event.answered } : q));
    case "question:removed":
      return list.filter((q) => q.id !== event.questionId);
  }
}
