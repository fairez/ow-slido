"use client";

import { useEffect, useState } from "react";
import { QUIZ_SHAPES } from "@/components/quiz-form";
import { useT } from "@/lib/i18n/client";
import type { PresenterQuiz as PresenterQuizState } from "@/lib/presenter";

const TICK_MS = 250;
const ANNOUNCE_AT = [10, 5];

function Shape({ index }: { index: number }) {
  return (
    <svg className="quiz-shape" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
      {QUIZ_SHAPES[index % QUIZ_SHAPES.length]}
    </svg>
  );
}

/**
 * A quiz question on the projector. Live: the prompt, the answer options, a countdown bar that prints the seconds
 * left and how many answers came in; no counts per option and no correct answer. Closed: the correct options and
 * the count per option. The countdown follows the server's `deadline_at`; `PresenterView` keys this component on
 * the deadline so a resumed question restarts it.
 */
export function PresenterQuiz({ quiz }: { quiz: PresenterQuizState }) {
  const t = useT();
  const [offset] = useState(() => quiz.serverNow - Date.now());
  const [now, setNow] = useState(quiz.serverNow);
  const [startSeconds] = useState(() => Math.max(0, Math.ceil(((quiz.deadlineAt ?? quiz.serverNow) - quiz.serverNow) / 1000)));
  const closed = quiz.state === "closed";
  const counting = quiz.state === "live" && quiz.deadlineAt !== null;
  const remainingMs = quiz.deadlineAt === null ? 0 : Math.max(0, quiz.deadlineAt - now);
  const secondsLeft = Math.ceil(remainingMs / 1000);
  const timeUp = counting && remainingMs <= 0;

  useEffect(() => {
    if (!counting || timeUp) return;
    const id = window.setInterval(() => setNow(Date.now() + offset), TICK_MS);
    return () => window.clearInterval(id);
  }, [counting, timeUp, offset]);

  // Derived, so the live region only changes on entering the 10 s and 5 s steps and at zero.
  const announcement = !counting
    ? ""
    : timeUp
      ? t("presQuiz.timeUp")
      : secondsLeft <= ANNOUNCE_AT[1]
        ? t("quiz.secondsLeft", { n: Math.min(ANNOUNCE_AT[1], startSeconds) })
        : secondsLeft <= ANNOUNCE_AT[0]
          ? t("quiz.secondsLeft", { n: Math.min(ANNOUNCE_AT[0], startSeconds) })
          : "";

  const answers = (n: number) => t(n === 1 ? "presQuiz.answers.one" : "presQuiz.answers.other", { n });
  const results = quiz.results;
  const top = Math.max(1, ...(results?.options.map((o) => o.count) ?? [1]));

  return (
    <>
      {quiz.prompt && quiz.prompt !== quiz.title && <p className="present-quiz-prompt">{quiz.prompt}</p>}

      {counting && (
        <div className="present-quiz-timer" data-urgent={secondsLeft <= 5}>
          <p className="present-quiz-seconds" aria-hidden="true">
            {timeUp ? t("presQuiz.timeUp") : t(secondsLeft === 1 ? "presQuiz.seconds.one" : "presQuiz.seconds.other", { n: secondsLeft })}
          </p>
          <span aria-hidden="true" className="present-track">
            <span
              className="present-fill present-quiz-fill"
              style={{ width: `${Math.min(100, (remainingMs / (quiz.timeLimitSeconds * 1000)) * 100)}%` }}
            />
          </span>
        </div>
      )}

      {!closed && (
        <ul className="present-quiz-options" aria-label={t("quiz.legend")}>
          {quiz.options.map((o, i) => (
            <li key={o.id} className="quiz-option" data-n={(i % 6) + 1}>
              <Shape index={i} />
              <span className="quiz-option-text">{o.text}</span>
            </li>
          ))}
        </ul>
      )}

      {closed && results && (
        <ol aria-label={t("presQuiz.resultsLabel")} className="present-bars present-quiz-results">
          {results.options.map((o, i) => (
            <li key={o.id} data-correct={o.correct}>
              <div className="present-bar-head">
                <span className="present-quiz-name">
                  <span className="quiz-swatch" data-n={(i % 6) + 1}>
                    <Shape index={i} />
                  </span>
                  <span className="present-quiz-text">{o.text}</span>
                  {o.correct && <span className="quiz-tag">{t("quiz.correctAnswer")}</span>}
                </span>
                <span>{answers(o.count)}</span>
              </div>
              <span aria-hidden="true" className="present-track">
                <span className="present-fill" data-leading={o.correct} style={{ width: `${(o.count / top) * 100}%` }} />
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className="present-total">
        {answers(quiz.total)}
        {closed && results?.correctPercent != null ? t("presQuiz.correctShare", { n: results.correctPercent }) : ""}
        {closed ? t("presQuiz.closed") : ""}
      </p>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
