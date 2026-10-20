"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError } from "@/components/ui/field";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";
import type { SurveyQuestion } from "@/lib/interaction-config";
import { RATING_SCALE_MAX } from "@/lib/rating-limits";
import { SURVEY_ANSWER_MAX } from "@/lib/survey-limits";
import type { SurveyPageData } from "@/lib/survey-page";

type Value = string[] | number | string;
type Answers = Record<string, Value>;

const isBlank = (value: Value | undefined) =>
  value === undefined || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0);

/** Participant form behind `/survey/<id>`: progress, required markers and one message per unanswered question. */
export function SurveyForm({ survey }: { survey: SurveyPageData }) {
  const t = useT();
  if (survey.status !== "open") {
    return (
      <>
        <Heading title={survey.title} eventName={survey.eventName} />
        <EmptyState title={t(survey.status === "closed" ? "surveyForm.closedTitle" : "surveyForm.notOpenTitle")} role="status">
          {t(survey.status === "closed" ? "surveyForm.closedBody" : "surveyForm.notOpenBody")}
        </EmptyState>
      </>
    );
  }
  return <OpenSurvey survey={survey} />;
}

function Heading({ title, eventName }: { title: string; eventName: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="field-meta survey-event">{eventName}</p>
    </>
  );
}

function OpenSurvey({ survey }: { survey: Extract<SurveyPageData, { status: "open" }> }) {
  const t = useT();
  const { questions } = survey;
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(survey.submitted);
  const [already, setAlready] = useState(survey.submitted);
  const [focusId, setFocusId] = useState<{ id: string; n: number } | null>(null);
  const fields = useRef(new Map<string, HTMLElement>());
  const joined = useRef<Promise<string | null> | null>(null);

  // Reaching the link creates or reuses the event participant (cookie); a failure is retried on submit.
  const join = (): Promise<string | null> => {
    joined.current ??= fetch(`/api/interactions/${survey.id}/survey/join`, { method: "POST" })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { error?: string; submitted?: boolean };
        if (res.ok) {
          if (body.submitted) {
            setAlready(true);
            setSubmitted(true);
          }
          return null;
        }
        joined.current = null;
        return body.error ?? SERVER_ERROR;
      })
      .catch(() => {
        joined.current = null;
        return NETWORK_ERROR;
      });
    return joined.current;
  };

  useEffect(() => {
    if (survey.submitted) return;
    void join().then((error) => error && setFormError(error));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page load
  }, []);

  useEffect(() => {
    if (!focusId) return;
    fields.current.get(focusId.id)?.querySelector<HTMLElement>("input, textarea")?.focus();
  }, [focusId]);

  const answered = questions.filter((q) => !isBlank(answers[q.id])).length;

  const set = (q: SurveyQuestion, value: Value) => {
    setAnswers((a) => ({ ...a, [q.id]: value }));
    if (!(q.id in errors)) return;
    const rest = { ...errors };
    delete rest[q.id];
    setErrors(rest);
    // The summary above the button goes with the last message.
    if (Object.keys(rest).length === 0) setFormError(null);
  };

  /** One message per unanswered question, a summary above the button, and focus on the first of them. */
  const flag = (ids: string[], message = t("surveyForm.needsAnswer"), summary?: string) => {
    setErrors(Object.fromEntries(ids.map((id) => [id, message])));
    setFormError(summary ?? t(ids.length === 1 ? "surveyForm.missing.one" : "surveyForm.missing.other", { n: ids.length }));
    const first = questions.find((q) => ids.includes(q.id));
    if (first) setFocusId((f) => ({ id: first.id, n: (f?.n ?? 0) + 1 }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || submitted) return;
    const missing = questions.filter((q) => q.required && isBlank(answers[q.id])).map((q) => q.id);
    if (missing.length) return flag(missing);
    setSubmitting(true);
    setErrors({});
    setFormError(null);
    try {
      const joinError = await join();
      if (joinError) return setFormError(joinError);
      const body: Answers = {};
      for (const q of questions) if (!isBlank(answers[q.id])) body[q.id] = answers[q.id];
      const res = await fetch(`/api/interactions/${survey.id}/survey`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: body }),
      });
      const reply = (await res.json().catch(() => ({}))) as { error?: string; reason?: string; questionId?: string; missing?: string[] };
      if (res.ok) setSubmitted(true);
      else if (res.status === 409 && reply.reason === "alreadySubmitted") {
        setAlready(true);
        setSubmitted(true);
      } else if (res.status === 400 && reply.missing?.length) flag(reply.missing);
      else if (res.status === 400 && reply.questionId) flag([reply.questionId], reply.error, reply.error);
      else setFormError(reply.error ?? SERVER_ERROR);
    } catch {
      setFormError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <>
        <Heading title={survey.title} eventName={survey.eventName} />
        <EmptyState title={t(already ? "surveyForm.alreadyTitle" : "surveyForm.thanksTitle")} role="status">
          {t(already ? "surveyForm.alreadyBody" : "surveyForm.thanksBody")}
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <Heading title={survey.title} eventName={survey.eventName} />
      <form onSubmit={submit} className="live-form survey-form" noValidate>
        <div className="survey-progress">
          <progress
            className="meter"
            max={questions.length}
            value={answered}
            aria-label={t("surveyForm.progressLabel")}
            data-full={answered === questions.length ? "" : undefined}
          />
          <p className="field-meta">{t("surveyForm.progress", { done: answered, total: questions.length })}</p>
        </div>
        <ol className="survey-list">
          {questions.map((q, i) => (
            <li key={q.id}>
              <Question
                question={q}
                index={i + 1}
                value={answers[q.id]}
                error={errors[q.id]}
                disabled={submitting}
                onChange={(value) => set(q, value)}
                register={(el) => (el ? fields.current.set(q.id, el) : fields.current.delete(q.id))}
              />
            </li>
          ))}
        </ol>
        {formError && <InlineError>{formError}</InlineError>}
        <Button type="submit" variant="primary" busy={submitting}>
          {submitting ? t("common.sending") : t("surveyForm.send")}
        </Button>
      </form>
    </>
  );
}

function Question({
  question: q,
  index,
  value,
  error,
  disabled,
  onChange,
  register,
}: {
  question: SurveyQuestion;
  index: number;
  value: Value | undefined;
  error?: string;
  disabled: boolean;
  onChange: (value: Value) => void;
  register: (el: HTMLElement | null) => void;
}) {
  const t = useT();
  const errorId = `survey-error-${q.id}`;
  const name = `survey-${q.id}`;
  const picked = Array.isArray(value) ? value : [];
  const stars = q.kind === "rating" && (q.scale ?? "stars5") === "stars5";
  const max = RATING_SCALE_MAX[q.scale ?? "stars5"];
  return (
    <fieldset className="survey-question" ref={register} aria-describedby={error ? errorId : undefined} disabled={disabled}>
      <legend>
        <span className="survey-question-n">{index}.</span> {q.text}
      </legend>
      <p className="ui-hint">
        {t(q.required ? "surveyForm.required" : "surveyForm.optional")}
        {q.kind === "choice" && <> · {t(q.multiple ? "surveyForm.pickMany" : "surveyForm.pickOne")}</>}
      </p>
      {q.kind === "choice" &&
        (q.options ?? []).map((o) => (
          <label key={o.id} className="ui-toggle">
            <input
              type={q.multiple ? "checkbox" : "radio"}
              name={name}
              checked={picked.includes(o.id)}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                if (!q.multiple) onChange([o.id]);
                else onChange(e.target.checked ? [...picked, o.id] : picked.filter((id) => id !== o.id));
              }}
            />
            <span>{o.text}</span>
          </label>
        ))}
      {q.kind === "rating" && (
        <div className="rating-scale">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
            const on = stars ? typeof value === "number" && n <= value : value === n;
            return (
              <label key={n} className="rating-choice" data-on={on} data-locked="false">
                <input
                  type="radio"
                  name={name}
                  value={n}
                  checked={value === n}
                  onChange={() => onChange(n)}
                  aria-label={stars ? t(n === 1 ? "rating.star.one" : "rating.star.other", { n }) : String(n)}
                />
                <span aria-hidden="true">{stars ? (on ? "★" : "☆") : n}</span>
              </label>
            );
          })}
        </div>
      )}
      {q.kind === "openText" && (
        <textarea
          rows={4}
          maxLength={SURVEY_ANSWER_MAX}
          value={typeof value === "string" ? value : ""}
          aria-label={t("surveyForm.answerLabel", { n: index })}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error && (
        <p className="ui-error" id={errorId}>
          {error}
        </p>
      )}
    </fieldset>
  );
}
