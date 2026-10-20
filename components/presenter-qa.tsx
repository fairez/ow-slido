"use client";

import { Badge } from "@/components/ui/card";
import { useT } from "@/lib/i18n/client";
import { orderQuestions, type QaSort } from "@/lib/question-order";
import type { MessageKey } from "@/lib/i18n";
import type { PublicQuestion } from "@/lib/question-types";

const SORTS: { id: QaSort; label: MessageKey }[] = [
  { id: "popular", label: "presQa.sort.popular" },
  { id: "recent", label: "presQa.sort.recent" },
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
  const t = useT();
  const ordered = orderQuestions(questions, sort);
  const count = questions.length;

  return (
    <div className="present-qa">
      <div className="present-qa-bar">
        <p className="present-total" role="status">
          {t(count === 1 ? "presQa.count.one" : "presQa.count.other", { n: count })}
        </p>
        <div className="present-qa-sort" role="group" aria-label={t("presQa.sortLabel")}>
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="present-qa-sort-btn"
              aria-pressed={sort === s.id}
              onClick={() => onSortChange(s.id)}
            >
              {t(s.label)}
            </button>
          ))}
        </div>
      </div>

      {ordered.length === 0 ? (
        <p role="status" className="present-empty">
          {t("presQa.empty", { code: joinCode })}
        </p>
      ) : (
        <ul className="present-qa-list" aria-label={t("presQa.listLabel")}>
          {ordered.map((q) => (
            <li key={q.id} className="present-qa-item" data-pinned={q.pinned} data-answered={q.answered}>
              <p className="present-qa-text">{q.text}</p>
              <p className="present-qa-meta">
                <span>{q.authorName?.trim() || t("common.anonymous")}</span>
                <span>{t(q.upvotes === 1 ? "presQa.upvotes.one" : "presQa.upvotes.other", { n: q.upvotes })}</span>
                {q.pinned && <Badge tone="accent">{t("common.pinned")}</Badge>}
                {q.answered && <Badge>{t("common.answered")}</Badge>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
