"use client";

import { Button } from "@/components/ui/button";
import { RATING_SCALE_MAX } from "@/lib/rating-limits";
import { useT } from "@/lib/i18n/client";
import type { SurveyQuestionDraft } from "@/components/survey-builder";

/** Read-only picture of the participant form: every control is disabled, nothing is sent. */
export function SurveyPreview({ title, questions }: { title: string; questions: SurveyQuestionDraft[] }) {
  const t = useT();
  return (
    <section className="survey-preview" aria-label={t("survey.previewTitle")}>
      <p className="ui-hint">{t("survey.previewNote")}</p>
      <fieldset className="survey-preview-form" disabled>
        <legend className="sr-only">{title.trim() || t("survey.previewUntitled")}</legend>
        <h4>{title.trim() || t("survey.previewUntitled")}</h4>
        <ol className="survey-preview-list">
          {questions.map((q, qi) => (
            <li key={q.id}>
              <fieldset className="survey-preview-question">
                <legend>{q.text.trim() || t("survey.previewBlankQuestion")}</legend>
                <p className="ui-hint">
                  {t(q.required ? "survey.previewRequired" : "survey.previewOptional")}
                  {q.kind === "choice" && <> · {t(q.multiple ? "survey.previewPickMany" : "survey.previewPickOne")}</>}
                </p>
                {q.kind === "choice" &&
                  q.options.map((o, i) => (
                    <label key={o.id} className="ui-toggle">
                      <input type={q.multiple ? "checkbox" : "radio"} name={`preview-${q.id}`} />
                      <span>{o.text.trim() || t("survey.optionN", { o: i + 1, n: qi + 1 })}</span>
                    </label>
                  ))}
                {q.kind === "rating" && (
                  <div className="rating-scale" role="img" aria-label={t("survey.previewStars", { max: RATING_SCALE_MAX[q.scale] })}>
                    {Array.from({ length: RATING_SCALE_MAX[q.scale] }, (_, i) => i + 1).map((n) => (
                      <span key={n} className="rating-choice" data-on="false" data-locked="true" aria-hidden="true">
                        {q.scale === "stars5" ? "☆" : n}
                      </span>
                    ))}
                  </div>
                )}
                {q.kind === "openText" && <textarea rows={3} aria-label={t("survey.previewAnswer")} placeholder={t("survey.previewAnswer")} />}
              </fieldset>
            </li>
          ))}
        </ol>
        <Button variant="primary">{t("survey.previewSubmit")}</Button>
      </fieldset>
    </section>
  );
}
