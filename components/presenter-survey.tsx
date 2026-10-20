"use client";

import { RatingChart } from "@/components/rating-chart";
import { useT } from "@/lib/i18n/client";
import type { QuestionResult, SurveyResults } from "@/lib/survey";

/** Response and completion counts, then one block per question; every share is printed as well as drawn. */
export function PresenterSurvey({ results, state }: { results: SurveyResults; state: "live" | "paused" | "closed" }) {
  const t = useT();
  return (
    <>
      <p className="present-total">
        {t(results.total === 1 ? "presSurvey.responses.one" : "presSurvey.responses.other", { n: results.total })}
        {" · "}
        {t("presSurvey.completed", { n: results.completed })}
        {state === "closed" ? t("presSurvey.closed") : ""}
      </p>
      <ol className="present-survey" aria-label={t("presSurvey.questionsLabel")}>
        {results.questions.map((q, i) => (
          <li key={q.id} className="present-survey-question">
            <h2 className="present-survey-text">
              <span className="present-rank">{i + 1}.</span> {q.text}
            </h2>
            <p className="present-survey-answered">
              {t(q.answered === 1 ? "presSurvey.answered.one" : "presSurvey.answered.other", { n: q.answered })}
            </p>
            <QuestionBody question={q} interactionId={results.interactionId} />
          </li>
        ))}
      </ol>
    </>
  );
}

function QuestionBody({ question: q, interactionId }: { question: QuestionResult; interactionId: string }) {
  const t = useT();
  if (q.kind === "choice") {
    const lead = Math.max(0, ...q.options.map((o) => o.count));
    return (
      <ul className="present-bars present-survey-bars">
        {q.options.map((o) => (
          <li key={o.id}>
            <div className="present-bar-head">
              <span>{o.text}</span>
              <span>
                {o.count} ({Math.round(o.percent)}%)
              </span>
            </div>
            <div
              className="present-track"
              role="progressbar"
              aria-label={o.text}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(o.percent)}
              aria-valuetext={t(o.count === 1 ? "presenter.votes.one" : "presenter.votes.other", { n: o.count, percent: Math.round(o.percent) })}
            >
              <div className="present-fill" data-leading={o.count > 0 && o.count === lead} style={{ width: `${o.percent}%` }} />
            </div>
          </li>
        ))}
      </ul>
    );
  }
  if (q.kind === "rating") {
    const max = q.scale === "stars5" ? 5 : 10;
    return (
      <>
        <p className="present-figure present-survey-average">
          {q.average === null ? (
            t("presRating.none")
          ) : (
            <>
              {q.average.toFixed(1)} <span className="present-figure-unit">{t("presRating.outOf", { max })}</span>
            </>
          )}
        </p>
        <RatingChart results={{ interactionId, scale: q.scale, total: q.answered, average: q.average, distribution: q.distribution }} />
      </>
    );
  }
  return q.latest.length === 0 ? (
    <p className="present-empty">{t("presOpenText.empty")}</p>
  ) : (
    <ul aria-label={t("presSurvey.latestLabel")} className="present-cards" data-stack>
      {q.latest.map((text, i) => (
        <li key={i} className="present-card">
          <p className="present-card-text">{text}</p>
        </li>
      ))}
    </ul>
  );
}
