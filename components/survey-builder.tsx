"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { InlineError, Select, TextField, TextArea, Toggle } from "@/components/ui/field";
import { SurveyPreview } from "@/components/survey-preview";
import { INTERACTION_PROMPT_MAX } from "@/lib/interaction-config";
import { SURVEY_KINDS, SURVEY_MAX_OPTIONS, SURVEY_MAX_QUESTIONS, SURVEY_MIN_OPTIONS, SURVEY_MIN_QUESTIONS, SURVEY_OPTION_MAX, SURVEY_QUESTION_MAX, type SurveyKind } from "@/lib/survey-limits";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n";

export type SurveyQuestionDraft = {
  id: string;
  kind: SurveyKind;
  text: string;
  required: boolean;
  multiple: boolean;
  scale: "stars5" | "numeric10";
  options: { id: string; text: string }[];
};
export type SurveyDraft = { id: string | null; title: string; questions: SurveyQuestionDraft[] };

/** The question shape stored in `interactions.config.questions`, as far as the builder reads it. */
export type StoredSurveyQuestion = {
  id: string;
  kind: SurveyKind;
  text: string;
  required?: boolean;
  options?: { id: string; text: string }[];
  multiple?: boolean;
  scale?: "stars5" | "numeric10";
};

/** Ids are made here because a save restates them; the server keeps the ones it is given. */
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const newOption = () => ({ id: newId("o"), text: "" });
const newQuestion = (): SurveyQuestionDraft => ({
  id: newId("q"),
  kind: "choice",
  text: "",
  required: false,
  multiple: false,
  scale: "stars5",
  options: Array.from({ length: SURVEY_MIN_OPTIONS }, newOption),
});

export const blankSurvey = (): SurveyDraft => ({ id: null, title: "", questions: [newQuestion()] });

export function surveyDraftFrom(id: string, title: string, questions: StoredSurveyQuestion[] | undefined): SurveyDraft {
  const drafts = (questions ?? []).map((q): SurveyQuestionDraft => {
    const fresh = newQuestion();
    return {
      ...fresh,
      id: q.id,
      kind: q.kind,
      text: q.text,
      required: q.required ?? false,
      multiple: q.multiple ?? false,
      scale: q.scale ?? "stars5",
      options: q.options?.length ? q.options.map((o) => ({ id: o.id, text: o.text })) : fresh.options,
    };
  });
  return { id, title, questions: drafts.length ? drafts : [newQuestion()] };
}

/** Each kind sends only its own fields. */
export function surveyBody(draft: SurveyDraft) {
  return {
    type: "survey" as const,
    title: draft.title,
    questions: draft.questions.map((q) => ({
      id: q.id,
      kind: q.kind,
      text: q.text,
      required: q.required,
      ...(q.kind === "choice" ? { options: q.options, multiple: q.multiple } : {}),
      ...(q.kind === "rating" ? { scale: q.scale } : {}),
    })),
  };
}

const KIND_LABELS: Record<SurveyKind, MessageKey> = {
  choice: "survey.kind.choice",
  rating: "survey.kind.rating",
  openText: "survey.kind.openText",
};

type Props = {
  initial: SurveyDraft;
  pending: boolean;
  error: string | null;
  onSave: (body: ReturnType<typeof surveyBody>, id: string | null) => void;
  onCancel: () => void;
};

/**
 * Builds a survey: a name and 1 to 20 questions of three kinds. Questions move with their own up/down buttons
 * (focus stays on the pressed button), changes that are not saved warn before the page or the form is left.
 */
export function SurveyBuilder({ initial, pending, error, onSave, onCancel }: Props) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const [preview, setPreview] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [status, setStatus] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string | null>(null);
  const [saved] = useState(() => JSON.stringify(initial));
  const dirty = JSON.stringify(draft) !== saved;

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    // Links in the page shell navigate on the client, which beforeunload does not see.
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (link.target === "_blank" || link.hasAttribute("download") || link.getAttribute("href")?.startsWith("#")) return;
      if (!window.confirm(t("survey.leaveWarning"))) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, t]);

  useEffect(() => {
    const selector = focusNext.current;
    focusNext.current = null;
    if (selector) root.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [draft.questions]);

  const setQuestions = (questions: SurveyQuestionDraft[]) => setDraft((d) => ({ ...d, questions }));
  const patch = (id: string, change: Partial<SurveyQuestionDraft>) =>
    setQuestions(draft.questions.map((q) => (q.id === id ? { ...q, ...change } : q)));

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    const question = draft.questions[index];
    if (target < 0 || target >= draft.questions.length) return;
    const next = [...draft.questions];
    next.splice(index, 1);
    next.splice(target, 0, question);
    focusNext.current = `[data-q="${question.id}"] [data-move="${delta < 0 ? "up" : "down"}"]`;
    setStatus(t("survey.moved", { n: target + 1, count: next.length }));
    setQuestions(next);
  }

  function add() {
    const question = newQuestion();
    focusNext.current = `[data-q="${question.id}"] [data-field="text"]`;
    setQuestions([...draft.questions, question]);
  }

  function remove(index: number) {
    const next = draft.questions.filter((_, i) => i !== index);
    const neighbour = next[Math.min(index, next.length - 1)];
    focusNext.current = `[data-q="${neighbour.id}"] [data-field="text"]`;
    setQuestions(next);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    onSave(surveyBody(draft), draft.id);
  }

  function cancel() {
    if (dirty) setConfirmDiscard(true);
    else onCancel();
  }

  const atMax = draft.questions.length >= SURVEY_MAX_QUESTIONS;
  const last = draft.questions.length - 1;

  return (
    <div ref={root}>
      <Card aria-labelledby="survey-draft-title">
        <form onSubmit={submit} className="form-stack">
          <h3 id="survey-draft-title">{t(draft.id ? "pollMgr.editType" : "pollMgr.newType", { type: t("pollMgr.type.survey").toLowerCase() })}</h3>
          {dirty && <p className="ui-hint survey-unsaved">{t("survey.unsaved")}</p>}
          <TextField
            label={t("survey.name")}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            required
            maxLength={INTERACTION_PROMPT_MAX}
          />
          <p className="ui-hint" aria-live="polite" data-testid="survey-count">
            {t("survey.count", { count: draft.questions.length, max: SURVEY_MAX_QUESTIONS })}
          </p>
          <ol className="row-list survey-questions" aria-label={t("survey.questionsLegend")}>
            {draft.questions.map((q, index) => {
              const n = index + 1;
              return (
                <li key={q.id} data-q={q.id}>
                  <fieldset className="form-group">
                    <legend>{t("survey.questionN", { n })}</legend>
                    <Select
                      label={t("survey.kind")}
                      value={q.kind}
                      onChange={(e) => patch(q.id, { kind: e.target.value as SurveyKind })}
                    >
                      {SURVEY_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(KIND_LABELS[kind])}
                        </option>
                      ))}
                    </Select>
                    <TextArea
                      label={t("survey.questionText")}
                      data-field="text"
                      rows={2}
                      value={q.text}
                      onChange={(e) => patch(q.id, { text: e.target.value })}
                      required
                      maxLength={SURVEY_QUESTION_MAX}
                    />
                    {q.kind === "choice" && (
                      <>
                        {q.options.map((option, oi) => (
                          <div key={option.id} className="option-row">
                            <input
                              value={option.text}
                              onChange={(e) => patch(q.id, { options: q.options.map((o) => (o.id === option.id ? { ...o, text: e.target.value } : o)) })}
                              aria-label={t("survey.optionN", { o: oi + 1, n })}
                              required
                              maxLength={SURVEY_OPTION_MAX}
                            />
                            <Button
                              variant="quiet"
                              aria-label={t("survey.removeOption", { o: oi + 1, n })}
                              disabled={q.options.length <= SURVEY_MIN_OPTIONS}
                              onClick={() => patch(q.id, { options: q.options.filter((o) => o.id !== option.id) })}
                            >
                              {t("pollMgr.remove")}
                            </Button>
                          </div>
                        ))}
                        <div>
                          <Button
                            aria-label={t("survey.addOption", { n })}
                            disabled={q.options.length >= SURVEY_MAX_OPTIONS}
                            onClick={() => patch(q.id, { options: [...q.options, newOption()] })}
                          >
                            {t("pollMgr.addOption")}
                          </Button>
                        </div>
                        <Toggle label={t("survey.multiple")} checked={q.multiple} onChange={(e) => patch(q.id, { multiple: e.target.checked })} />
                      </>
                    )}
                    {q.kind === "rating" && (
                      <fieldset className="form-group" aria-label={t("survey.scaleFor", { n })}>
                        <legend>{t("pollMgr.scale")}</legend>
                        <label className="ui-toggle">
                          <input type="radio" name={`scale-${q.id}`} checked={q.scale === "stars5"} onChange={() => patch(q.id, { scale: "stars5" })} /> {t("pollMgr.stars")}
                        </label>
                        <label className="ui-toggle">
                          <input type="radio" name={`scale-${q.id}`} checked={q.scale === "numeric10"} onChange={() => patch(q.id, { scale: "numeric10" })} /> {t("pollMgr.numbers")}
                        </label>
                      </fieldset>
                    )}
                    <Toggle label={t("survey.required")} checked={q.required} onChange={(e) => patch(q.id, { required: e.target.checked })} />
                    <div className="row-actions row-actions-quiet">
                      <Button
                        variant="quiet"
                        data-move="up"
                        aria-label={t("survey.moveUp", { n })}
                        aria-disabled={index === 0 || undefined}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        variant="quiet"
                        data-move="down"
                        aria-label={t("survey.moveDown", { n })}
                        aria-disabled={index === last || undefined}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        variant="quiet"
                        aria-label={t("survey.removeQuestion", { n })}
                        disabled={draft.questions.length <= SURVEY_MIN_QUESTIONS}
                        onClick={() => remove(index)}
                      >
                        {t("pollMgr.remove")}
                      </Button>
                    </div>
                  </fieldset>
                </li>
              );
            })}
          </ol>
          <p className="sr-only" role="status">
            {status}
          </p>
          <div className="row-actions">
            <Button disabled={atMax} onClick={add}>
              {t("survey.addQuestion")}
            </Button>
            <Button aria-expanded={preview} aria-controls="survey-preview" onClick={() => setPreview((v) => !v)}>
              {t(preview ? "survey.previewHide" : "survey.previewShow")}
            </Button>
          </div>
          {preview && (
            <div id="survey-preview">
              <SurveyPreview title={draft.title} questions={draft.questions} />
            </div>
          )}
          {error && <InlineError>{error}</InlineError>}
          <div className="row-actions">
            <Button type="submit" variant="primary" busy={pending}>
              {pending ? t("pollMgr.saving") : t("pollMgr.saveType", { type: t("pollMgr.type.survey").toLowerCase() })}
            </Button>
            <Button onClick={cancel}>{t("pollMgr.cancel")}</Button>
          </div>
        </form>
      </Card>
      <Dialog open={confirmDiscard} title={t("survey.discardTitle")} onClose={() => setConfirmDiscard(false)}>
        <p>{t("survey.discardBody")}</p>
        <div className="row-actions">
          <Button onClick={() => setConfirmDiscard(false)}>{t("survey.discardKeep")}</Button>
          <Button variant="primary" onClick={onCancel}>
            {t("survey.discardConfirm")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
