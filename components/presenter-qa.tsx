import { Badge } from "@/components/ui/card";
import { orderQuestions, type QaSort } from "@/lib/question-order";
import type { PublicQuestion } from "@/lib/question-types";

const SORTS: { id: QaSort; label: string }[] = [
  { id: "popular", label: "Most upvoted" },
  { id: "recent", label: "Newest" },
];

/** Q&A on the projector: approved questions in large type, pinned first and answered ones dimmed at the end. */
export function PresenterQa({
  questions,
  sort,
  onSortChange,
  joinCode,
}: {
  questions: PublicQuestion[];
  sort: QaSort;
  onSortChange: (sort: QaSort) => void;
  joinCode: string;
}) {
  const ordered = orderQuestions(questions, sort);
  const count = questions.length;

  return (
    <div className="present-qa">
      <div className="present-qa-bar">
        <p className="present-total" role="status">
          {count === 1 ? "1 question" : `${count} questions`}
        </p>
        <div className="present-qa-sort" role="group" aria-label="Order questions by">
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="present-qa-sort-btn"
              aria-pressed={sort === s.id}
              onClick={() => onSortChange(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {ordered.length === 0 ? (
        <p role="status" className="present-empty">
          No questions yet. Ask from your phone with code {joinCode}.
        </p>
      ) : (
        <ul className="present-qa-list" aria-label="Questions">
          {ordered.map((q) => (
            <li key={q.id} className="present-qa-item" data-pinned={q.pinned} data-answered={q.answered}>
              <p className="present-qa-text">{q.text}</p>
              <p className="present-qa-meta">
                <span>{q.authorName?.trim() || "Anonymous"}</span>
                <span>{q.upvotes === 1 ? "1 upvote" : `${q.upvotes} upvotes`}</span>
                {q.pinned && <Badge tone="accent">Pinned</Badge>}
                {q.answered && <Badge>Answered</Badge>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
