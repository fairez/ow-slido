"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { WORDCLOUD_MAX_ENTRIES, WORDCLOUD_MIN_ENTRIES, WORDCLOUD_PROMPT_MAX } from "@/lib/wordcloud-limits";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { INTERACTION_PROMPT_MAX, NOTES_MAX, NOTES_MIN, OPEN_TEXT_MAX, OPEN_TEXT_MIN, QA_DEFAULT_PROMPT, QA_DEFAULT_TITLE } from "@/lib/interaction-config";
import { NotesAnalysisPanel } from "@/components/notes-analysis-panel";
import { OpenTextHostPanel } from "@/components/open-text-host-panel";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { InlineError, TextField, Toggle } from "@/components/ui/field";
import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX } from "@/lib/poll-limits";
import { RANKING_MAX_OPTIONS, RANKING_MIN_OPTIONS, RANKING_OPTION_MAX } from "@/lib/ranking-limits";
import {
  QUIZ_MAX_OPTIONS,
  QUIZ_MIN_OPTIONS,
  QUIZ_OPTION_MAX,
  QUIZ_POINTS_DEFAULT,
  QUIZ_POINTS_MAX,
  QUIZ_POINTS_MIN,
  QUIZ_TIME_DEFAULT,
  QUIZ_TIME_MAX,
  QUIZ_TIME_MIN,
} from "@/lib/quiz-limits";
import { AddContentMenu } from "@/components/add-content-menu";
import { PlanHint } from "@/components/plan-hint";
import { SaveTemplateDialog, type SaveTarget } from "@/components/save-template-dialog";
import { SurveyBuilder, blankSurvey, surveyDraftFrom, type StoredSurveyQuestion, type SurveyDraft, type surveyBody } from "@/components/survey-builder";
import { TemplatePicker } from "@/components/template-picker";
import { GripIcon, TypeIcon } from "@/components/type-icon";
import { useCoalesced } from "@/lib/use-coalesced";
import type { Lock } from "@/lib/plan-hints";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n";
import { TYPE_LABELS } from "@/lib/type-labels";

export type InteractionItem = {
  id: string;
  type: "poll" | "wordcloud" | "sharedNotes" | "openText" | "rating" | "qa" | "ranking" | "quiz" | "survey";
  title: string;
  state: "draft" | "live" | "paused" | "closed";
  position: number;
  config: {
    options?: { id: string; label?: string; text?: string }[];
    multiSelect?: boolean;
    showResultsToParticipants?: boolean;
    prompt?: string;
    maxEntriesPerParticipant?: number;
    maxNotesPerParticipant?: number;
    moderation?: "open" | "moderated";
    profanityFilter?: boolean;
    showAuthorNames?: boolean;
    maxResponsesPerParticipant?: number;
    scale?: "stars5" | "numeric10";
    correctOptionIds?: string[];
    timeLimitSeconds?: number;
    points?: number;
    questions?: StoredSurveyQuestion[];
  };
};

type Kind = "poll" | "wordcloud" | "sharedNotes" | "openText" | "rating" | "qa" | "ranking" | "quiz";
/** What the Add content menu offers: the form kinds plus the survey, which has its own builder. */
type AddKind = Kind | "survey";

/** Option count and text length the server accepts for a kind with an option list. */
const OPTION_LIMITS = {
  poll: { min: POLL_MIN_OPTIONS, max: POLL_MAX_OPTIONS, text: POLL_OPTION_MAX },
  ranking: { min: RANKING_MIN_OPTIONS, max: RANKING_MAX_OPTIONS, text: RANKING_OPTION_MAX },
  quiz: { min: QUIZ_MIN_OPTIONS, max: QUIZ_MAX_OPTIONS, text: QUIZ_OPTION_MAX },
} as const;
const optionLimits = (kind: Kind) => OPTION_LIMITS[kind as keyof typeof OPTION_LIMITS];
const STATE_LABELS: Record<InteractionItem["state"], MessageKey> = {
  draft: "pollMgr.state.draft",
  live: "pollMgr.state.live",
  paused: "pollMgr.state.paused",
  closed: "pollMgr.state.closed",
};

/** Realtime messages after which the list (and its response counts) may be out of date. */
const REFRESH_EVENTS = [
  "content:changed",
  "state-changed",
  "poll:counts",
  "wordcloud:words",
  "rating:results",
  "ranking:results",
  "quiz:results",
  "response:added",
  "response:removed",
  "note:added",
  "note:removed",
  "note:pending",
  "question:added",
  "question:pending",
  "question:removed",
];

/** The field of the PATCH body that carries an interaction's name, which differs by type. */
const nameBody = (type: InteractionItem["type"], name: string) =>
  type === "poll" ? { question: name } : type === "qa" || type === "survey" ? { title: name } : { prompt: name };

const ADD_BUTTONS: { kind: AddKind; label: MessageKey }[] = [
  { kind: "poll", label: "pollMgr.newPoll" },
  { kind: "wordcloud", label: "pollMgr.newWordcloud" },
  { kind: "sharedNotes", label: "pollMgr.newSharedNotes" },
  { kind: "openText", label: "pollMgr.newOpenText" },
  { kind: "rating", label: "pollMgr.newRating" },
  { kind: "ranking", label: "pollMgr.newRanking" },
  { kind: "quiz", label: "pollMgr.newQuiz" },
  { kind: "survey", label: "pollMgr.newSurvey" },
  { kind: "qa", label: "pollMgr.newQa" },
];

type Draft = { timeLimit: number; points: number; qaPrompt: string; profanity: boolean; kind: Kind; scale: "stars5" | "numeric10"; maxResponses: number; maxNotes: number; moderated: boolean; showAuthors: boolean; maxEntries: number; id: string | null; question: string; options: { id?: string; label: string; correct?: boolean }[]; multiSelect: boolean; showResults: boolean };

/** A quiz option carries its id from the start: `correctOptionIds` in the same request points at it. */
const newQuizOption = () => ({ id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, label: "", correct: false });

const blank = (kind: Draft["kind"] = "poll", defaultModeration: "open" | "moderated" = "open"): Draft => ({ kind, timeLimit: QUIZ_TIME_DEFAULT, points: QUIZ_POINTS_DEFAULT, qaPrompt: QA_DEFAULT_PROMPT, profanity: true, scale: "stars5", maxResponses: 1, maxNotes: 3, moderated: kind === "qa" && defaultModeration === "moderated", showAuthors: false, maxEntries: 3, id: null, question: kind === "qa" ? QA_DEFAULT_TITLE : "", options: kind === "quiz" ? [newQuizOption(), newQuizOption()] : [{ label: "" }, { label: "" }], multiSelect: false, showResults: false });

async function errorFrom(response: Response) {
  const body = await response.json().catch(() => null);
  return body?.error ?? SERVER_ERROR;
}

type PollManagerProps = {
  eventId: string;
  initialInteractions: InteractionItem[];
  aiEnabled?: boolean;
  /** Types the plan leaves out; their add buttons turn into a pointer to the plan page. */
  lockedTypes?: Partial<Record<AddKind, Lock>>;
  /** Set when the plan has no AI calls: the analysis button turns into a pointer to the plan page. */
  aiLock?: Lock;
  /** Interactions a downgrade left read-only, by id: they keep their results but cannot be started, edited or duplicated. */
  itemLocks?: Record<string, Lock>;
  /** Set when the whole event is past the plan's monthly limit: nothing new can be added to it. */
  eventLock?: Lock;
  /** The event's moderation mode: the starting choice for a new Q&A. */
  defaultModeration?: "open" | "moderated";
  /** Response count per interaction id, as of the page load. */
  initialCounts?: Record<string, number>;
  /** Follow changes made by other members and new responses over the event socket. */
  liveUpdates?: boolean;
  /** Owners and admins: items and the whole event can be saved as templates. */
  canManageTemplates?: boolean;
  /** Starting name when the whole event is saved as a template. */
  eventName?: string;
};

export function PollManager({ eventId, initialInteractions, aiEnabled = false, lockedTypes = {}, aiLock, itemLocks = {}, eventLock, defaultModeration = "open", initialCounts = {}, liveUpdates = false, canManageTemplates = false, eventName = "" }: PollManagerProps) {
  const t = useT();
  const typeLabel = (kind: InteractionItem["type"]) => t(TYPE_LABELS[kind]);
  // Mid-sentence type names are lower case, except "Q&A".
  const typeInSentence = (kind: InteractionItem["type"]) => (kind === "qa" ? typeLabel(kind) : typeLabel(kind).toLowerCase());
  const base = `/api/events/${eventId}/interactions`;
  // Only needed for live analysis status; stays disconnected when AI is off.
  const { socket } = useEventSocket(eventId, "host", aiEnabled || liveUpdates);
  const [items, setItems] = useState(initialInteractions);
  const [counts, setCounts] = useState(initialCounts);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [survey, setSurvey] = useState<SurveyDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState<InteractionItem | null>(null);
  const [saveTarget, setSaveTarget] = useState<SaveTarget | null>(null);
  const [picking, setPicking] = useState(false);
  const [templateNotice, setTemplateNotice] = useState<{ key: "templates.saved" | "templates.added"; name: string } | null>(null);

  async function call(url: string, init: RequestInit): Promise<Response | null> {
    setError(null);
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        setError(await errorFrom(response));
        return null;
      }
      return response;
    } catch {
      setError(NETWORK_ERROR);
      return null;
    }
  }

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(base);
      if (!response.ok) return;
      const body = (await response.json()) as { interactions: InteractionItem[]; counts: Record<string, number> };
      setItems(body.interactions);
      setCounts(body.counts);
    } catch {
      // The next realtime message or reload tries again.
    }
  }, [base]);
  const refreshSoon = useCoalesced(refresh, 300);

  useEffect(() => {
    if (!liveUpdates || !socket) return;
    for (const name of REFRESH_EVENTS) socket.on(name, refreshSoon);
    socket.on("connect", refreshSoon);
    return () => {
      for (const name of REFRESH_EVENTS) socket.off(name, refreshSoon);
      socket.off("connect", refreshSoon);
    };
  }, [liveUpdates, socket, refreshSoon]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const body =
      draft.kind === "qa"
        ? {
            type: "qa",
            title: draft.question,
            prompt: draft.qaPrompt,
            moderation: draft.moderated ? "moderated" : "open",
            profanityFilter: draft.profanity,
          }
        : draft.kind === "quiz"
        ? {
            type: "quiz",
            prompt: draft.question,
            options: draft.options.map((o) => ({ id: o.id, text: o.label })),
            correctOptionIds: draft.options.filter((o) => o.correct).flatMap((o) => (o.id ? [o.id] : [])),
            timeLimitSeconds: draft.timeLimit,
            points: draft.points,
          }
        : draft.kind === "ranking"
        ? { type: "ranking", prompt: draft.question, options: draft.options.map((o) => ({ id: o.id, text: o.label })) }
        : draft.kind === "rating"
        ? { type: "rating", prompt: draft.question, scale: draft.scale }
        : draft.kind === "openText"
        ? { type: "openText", prompt: draft.question, maxResponsesPerParticipant: draft.maxResponses }
        : draft.kind === "sharedNotes"
        ? {
            type: "sharedNotes",
            prompt: draft.question,
            maxNotesPerParticipant: draft.maxNotes,
            moderation: draft.moderated ? "moderated" : "open",
            showAuthorNames: draft.showAuthors,
          }
        : draft.kind === "wordcloud"
        ? { type: "wordcloud", prompt: draft.question, maxEntriesPerParticipant: draft.maxEntries }
        : {
            type: "poll",
            question: draft.question,
            options: draft.options,
            multiSelect: draft.multiSelect,
            showResultsToParticipants: draft.showResults,
          };
    setPending(true);
    const response = draft.id
      ? await call(`${base}/${draft.id}`, { ...json(body), method: "PATCH" })
      : await call(base, json(body));
    setPending(false);
    if (!response) return;
    const { interaction } = (await response.json()) as { interaction: InteractionItem };
    setItems((list) =>
      draft.id ? list.map((i) => (i.id === interaction.id ? interaction : i)) : [...list, interaction],
    );
    setDraft(null);
  }

  async function saveSurvey(body: ReturnType<typeof surveyBody>, id: string | null) {
    setPending(true);
    const response = id ? await call(`${base}/${id}`, { ...json(body), method: "PATCH" }) : await call(base, json(body));
    setPending(false);
    if (!response) return;
    const { interaction } = (await response.json()) as { interaction: InteractionItem };
    setItems((list) => (id ? list.map((i) => (i.id === interaction.id ? interaction : i)) : [...list, interaction]));
    setSurvey(null);
  }

  async function duplicate(item: InteractionItem) {
    const response = await call(`${base}/${item.id}/duplicate`, { method: "POST" });
    if (!response) return;
    const { interaction } = (await response.json()) as { interaction: InteractionItem };
    setItems((list) => [...list, interaction]);
  }

  async function transition(item: InteractionItem, action: "start" | "pause" | "close") {
    const response = await call(`${base}/${item.id}/${action}`, { method: "POST" });
    if (!response) return;
    const { interaction } = (await response.json()) as { interaction: InteractionItem };
    // Starting pauses the previously live interaction on the server; it can be resumed.
    setItems((list) =>
      list.map((i) =>
        i.id === interaction.id ? interaction : action === "start" && i.state === "live" ? { ...i, state: "paused" } : i,
      ),
    );
  }

  async function remove(item: InteractionItem) {
    const response = await call(`${base}/${item.id}`, { method: "DELETE" });
    setDeleting(null);
    if (response) setItems((list) => list.filter((i) => i.id !== item.id));
  }

  async function moveTo(from: number, target: number) {
    if (from === target || target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    const response = await call(`${base}/reorder`, json({ ids: next.map((i) => i.id) }));
    if (response) setItems(next);
  }

  const move = (index: number, delta: -1 | 1) => moveTo(index, index + delta);

  async function rename(item: InteractionItem, name: string) {
    const response = await call(`${base}/${item.id}`, { ...json(nameBody(item.type, name)), method: "PATCH" });
    if (!response) return;
    const { interaction } = (await response.json()) as { interaction: InteractionItem };
    setItems((list) => list.map((i) => (i.id === interaction.id ? interaction : i)));
    setRenaming(null);
  }

  function edit(item: InteractionItem) {
    setError(null);
    if (item.type === "survey") {
      setSurvey(surveyDraftFrom(item.id, item.title, item.config.questions));
      return;
    }
    setDraft({
      qaPrompt: item.config.prompt ?? QA_DEFAULT_PROMPT,
      profanity: item.config.profanityFilter ?? true,
      kind: item.type as Kind,
      scale: item.config.scale ?? "stars5",
      maxResponses: item.config.maxResponsesPerParticipant ?? 1,
      maxNotes: item.config.maxNotesPerParticipant ?? 3,
      moderated: item.config.moderation === "moderated",
      showAuthors: item.config.showAuthorNames ?? false,
      maxEntries: item.config.maxEntriesPerParticipant ?? 3,
      id: item.id,
      question: item.title,
      timeLimit: item.config.timeLimitSeconds ?? QUIZ_TIME_DEFAULT,
      points: item.config.points ?? QUIZ_POINTS_DEFAULT,
      options: (item.config.options ?? []).map((o) => ({
        id: o.id,
        label: o.label ?? o.text ?? "",
        correct: item.config.correctOptionIds?.includes(o.id) ?? false,
      })),
      multiSelect: item.config.multiSelect ?? false,
      showResults: item.config.showResultsToParticipants ?? false,
    });
  }

  function setOption(index: number, label: string) {
    setDraft((d) => d && { ...d, options: d.options.map((o, i) => (i === index ? { ...o, label } : o)) });
  }

  const maxLength =
    draft?.kind === "wordcloud" ? WORDCLOUD_PROMPT_MAX : draft?.kind === "poll" ? POLL_QUESTION_MAX : INTERACTION_PROMPT_MAX;
  const numberField = (label: string, value: number, min: number, max: number, set: (n: number) => void) => (
    <TextField
      label={label}
      type="number"
      min={min}
      max={max}
      step={1}
      value={Number.isNaN(value) ? "" : value}
      onChange={(e) => set(e.target.valueAsNumber)}
      required
    />
  );

  return (
    <section aria-labelledby="interactions-title" className="stack">
      <h2 id="interactions-title">{t("pollMgr.title")}</h2>
      {error && !draft && !survey && <InlineError>{error}</InlineError>}
      {templateNotice && (
        <div role="status" className="notice">
          <p>{t(templateNotice.key, { name: templateNotice.name })}</p>
          {templateNotice.key === "templates.saved" && (
            <p>
              <Link href="/dashboard/templates">{t("templates.viewAll")}</Link>
            </p>
          )}
        </div>
      )}
      {items.length === 0 ? (
        <EmptyState title={t("pollMgr.emptyTitle")}>{t("pollMgr.emptyBody")}</EmptyState>
      ) : (
        <ul className="row-list">
          {items.map((item, index) => {
            const lock = itemLocks[item.id];
            return (
            <li
              key={item.id}
              className="interaction-row"
              data-state={item.state}
              data-dragging={dragFrom === index || undefined}
              onDragOver={(e) => dragFrom !== null && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null) void moveTo(dragFrom, index);
                setDragFrom(null);
              }}
            >
              <div className="interaction-head">
                {!eventLock && (
                  <span
                    className="drag-handle"
                    draggable
                    aria-hidden="true"
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", item.id);
                      setDragFrom(index);
                    }}
                    onDragEnd={() => setDragFrom(null)}
                  >
                    <GripIcon />
                  </span>
                )}
                <div className="event-main">
                  {renaming?.id === item.id ? (
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void rename(item, renaming.name);
                      }}
                    >
                      <TextField
                        label={t("pollMgr.renameField")}
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: item.id, name: e.target.value })}
                        maxLength={item.type === "poll" ? POLL_QUESTION_MAX : INTERACTION_PROMPT_MAX}
                        required
                      />
                      <Button type="submit" variant="primary">{t("pollMgr.renameSave")}</Button>
                      <Button onClick={() => setRenaming(null)}>{t("pollMgr.cancel")}</Button>
                    </form>
                  ) : (
                    <h3 className="event-name">{item.title}</h3>
                  )}
                  <div className="row-meta">
                    <span className="type-tag"><TypeIcon kind={item.type} /> {typeLabel(item.type)}</span>{" "}
                    <Badge tone={item.state === "live" ? "accent" : "neutral"}><span data-testid="state">{t(STATE_LABELS[item.state])}</span></Badge>{" "}
                    <span data-testid="count">{t((counts[item.id] ?? 0) === 1 ? "pollMgr.responses.one" : "pollMgr.responses.other", { count: counts[item.id] ?? 0 })}</span>
                    {lock && <> <Badge>{t("pollMgr.readOnly")}</Badge></>}
                  </div>
                </div>
                {item.state !== "closed" && (
                  <div className="row-actions">
                    {lock && item.state !== "live" && <PlanHint lock={lock}>{t("pollMgr.unlock")}</PlanHint>}
                    {!lock && item.state === "draft" && (
                      <Button variant="primary" onClick={() => transition(item, "start")}>{t("pollMgr.start")}</Button>
                    )}
                    {!lock && item.state === "paused" && (
                      <Button variant="primary" onClick={() => transition(item, "start")}>{t("pollMgr.resume")}</Button>
                    )}
                    {item.state === "live" && (
                      <Button variant="secondary" onClick={() => transition(item, "pause")}>{t("pollMgr.pause")}</Button>
                    )}
                    {item.state !== "draft" && (
                      <Button variant={item.state === "live" ? "primary" : "secondary"} onClick={() => transition(item, "close")}>{t("pollMgr.close")}</Button>
                    )}
                  </div>
                )}
              </div>
              {item.type === "openText" && item.state !== "draft" && <OpenTextHostPanel eventId={eventId} interactionId={item.id} live={item.state === "live"} />}
              {item.type === "sharedNotes" && item.state !== "draft" && aiEnabled && (aiLock ? (
                <div className="row-actions"><PlanHint lock={aiLock}>{t("notesAnalysis.analyze")}</PlanHint></div>
              ) : (
                <NotesAnalysisPanel interactionId={item.id} socket={socket} />
              ))}
              <div className="row-actions row-actions-quiet">
                {item.state === "draft" && !lock && <Button variant="quiet" onClick={() => edit(item)}>{t("pollMgr.edit")}</Button>}
                {item.state === "draft" && !lock && <Button variant="quiet" onClick={() => { setError(null); setRenaming({ id: item.id, name: item.title }); }}>{t("pollMgr.rename")}</Button>}
                {!lock && <Button variant="quiet" onClick={() => duplicate(item)}>{t("pollMgr.duplicate")}</Button>}
                {canManageTemplates && (
                  <Button variant="quiet" aria-label={t("templates.saveItemFor", { title: item.title })} onClick={() => setSaveTarget({ interactionId: item.id, defaultName: item.title })}>
                    {t("templates.saveItem")}
                  </Button>
                )}
                {item.state === "draft" && <Button variant="quiet" onClick={() => setDeleting(item)}>{t("pollMgr.delete")}</Button>}
                {!eventLock && <Button variant="quiet" aria-label={t("pollMgr.moveUp", { title: item.title })} disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>}
                {!eventLock && <Button variant="quiet" aria-label={t("pollMgr.moveDown", { title: item.title })} disabled={index === items.length - 1} onClick={() => move(index, 1)}>↓</Button>}
              </div>
            </li>
            );
          })}
        </ul>
      )}

      {survey ? (
        <SurveyBuilder
          key={survey.id ?? "new"}
          initial={survey}
          pending={pending}
          error={error}
          onSave={saveSurvey}
          onCancel={() => { setError(null); setSurvey(null); }}
        />
      ) : draft ? (
        <Card aria-labelledby="draft-title">
          <form onSubmit={save} className="form-stack">
            <h3 id="draft-title">{t(draft.id ? "pollMgr.editType" : "pollMgr.newType", { type: typeInSentence(draft.kind) })}</h3>
            <TextField
              label={draft.kind === "poll" ? t("pollMgr.question") : draft.kind === "qa" ? t("pollMgr.qaName") : t("pollMgr.prompt")}
              value={draft.question}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
              required
              maxLength={maxLength}
            />
            {(draft.kind === "poll" || draft.kind === "ranking" || draft.kind === "quiz") && (
              <fieldset className="form-group">
                <legend>{t("pollMgr.options")}</legend>
                {draft.options.map((option, index) => (
                  <div key={option.id ?? index} className="option-row">
                    <input
                      value={option.label}
                      onChange={(e) => setOption(index, e.target.value)}
                      aria-label={t("pollMgr.optionN", { n: index + 1 })}
                      required
                      maxLength={optionLimits(draft.kind).text}
                    />
                    {draft.kind === "quiz" && (
                      <label className="ui-toggle option-correct">
                        <input
                          type="checkbox"
                          aria-label={t("pollMgr.correctN", { n: index + 1 })}
                          checked={option.correct ?? false}
                          onChange={(e) => setDraft({ ...draft, options: draft.options.map((o, i) => (i === index ? { ...o, correct: e.target.checked } : o)) })}
                        />
                        {t("pollMgr.correct")}
                      </label>
                    )}
                    <Button
                      variant="quiet"
                      aria-label={t("pollMgr.removeOptionN", { n: index + 1 })}
                      disabled={draft.options.length <= optionLimits(draft.kind).min}
                      onClick={() => setDraft({ ...draft, options: draft.options.filter((_, i) => i !== index) })}
                    >
                      {t("pollMgr.remove")}
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    disabled={draft.options.length >= optionLimits(draft.kind).max}
                    onClick={() => setDraft({ ...draft, options: [...draft.options, draft.kind === "quiz" ? newQuizOption() : { label: "" }] })}
                  >
                    {t("pollMgr.addOption")}
                  </Button>
                </div>
                {draft.kind === "poll" && (
                  <>
                    <Toggle label={t("pollMgr.multiSelect")} checked={draft.multiSelect} onChange={(e) => setDraft({ ...draft, multiSelect: e.target.checked })} />
                    <Toggle label={t("pollMgr.showResults")} checked={draft.showResults} onChange={(e) => setDraft({ ...draft, showResults: e.target.checked })} />
                  </>
                )}
              </fieldset>
            )}
            {draft.kind === "qa" && (
              <>
                <TextField
                  label={t("pollMgr.qaPrompt")}
                  value={draft.qaPrompt}
                  onChange={(e) => setDraft({ ...draft, qaPrompt: e.target.value })}
                  required
                  maxLength={INTERACTION_PROMPT_MAX}
                />
                <fieldset className="form-group">
                  <legend>{t("pollMgr.moderation")}</legend>
                  <label className="ui-toggle">
                    <input type="radio" name="moderation" checked={!draft.moderated} onChange={() => setDraft({ ...draft, moderated: false })} /> {t("pollMgr.qaModOpen")}
                  </label>
                  <label className="ui-toggle">
                    <input type="radio" name="moderation" checked={draft.moderated} onChange={() => setDraft({ ...draft, moderated: true })} /> {t("pollMgr.qaModModerated")}
                  </label>
                </fieldset>
                <Toggle label={t("pollMgr.profanityFilter")} checked={draft.profanity} onChange={(e) => setDraft({ ...draft, profanity: e.target.checked })} />
              </>
            )}
            {draft.kind === "quiz" && (
              <>
                {numberField(t("pollMgr.timeLimit"), draft.timeLimit, QUIZ_TIME_MIN, QUIZ_TIME_MAX, (n) => setDraft({ ...draft, timeLimit: n }))}
                {numberField(t("pollMgr.quizPoints"), draft.points, QUIZ_POINTS_MIN, QUIZ_POINTS_MAX, (n) => setDraft({ ...draft, points: n }))}
              </>
            )}
            {draft.kind === "wordcloud" && numberField(t("pollMgr.entriesPer"), draft.maxEntries, WORDCLOUD_MIN_ENTRIES, WORDCLOUD_MAX_ENTRIES, (n) => setDraft({ ...draft, maxEntries: n }))}
            {draft.kind === "openText" && numberField(t("pollMgr.responsesPer"), draft.maxResponses, OPEN_TEXT_MIN, OPEN_TEXT_MAX, (n) => setDraft({ ...draft, maxResponses: n }))}
            {draft.kind === "rating" && (
              <fieldset className="form-group">
                <legend>{t("pollMgr.scale")}</legend>
                <label className="ui-toggle">
                  <input type="radio" name="scale" checked={draft.scale === "stars5"} onChange={() => setDraft({ ...draft, scale: "stars5" })} /> {t("pollMgr.stars")}
                </label>
                <label className="ui-toggle">
                  <input type="radio" name="scale" checked={draft.scale === "numeric10"} onChange={() => setDraft({ ...draft, scale: "numeric10" })} /> {t("pollMgr.numbers")}
                </label>
              </fieldset>
            )}
            {draft.kind === "sharedNotes" && (
              <>
                {numberField(t("pollMgr.notesPer"), draft.maxNotes, NOTES_MIN, NOTES_MAX, (n) => setDraft({ ...draft, maxNotes: n }))}
                <fieldset className="form-group">
                  <legend>{t("pollMgr.moderation")}</legend>
                  <label className="ui-toggle">
                    <input type="radio" name="moderation" checked={!draft.moderated} onChange={() => setDraft({ ...draft, moderated: false })} /> {t("pollMgr.modOpen")}
                  </label>
                  <label className="ui-toggle">
                    <input type="radio" name="moderation" checked={draft.moderated} onChange={() => setDraft({ ...draft, moderated: true })} /> {t("pollMgr.modModerated")}
                  </label>
                </fieldset>
                <Toggle label={t("pollMgr.showAuthors")} checked={draft.showAuthors} onChange={(e) => setDraft({ ...draft, showAuthors: e.target.checked })} />
              </>
            )}
            {error && <InlineError>{error}</InlineError>}
            <div className="row-actions">
              <Button type="submit" variant="primary" busy={pending}>{pending ? t("pollMgr.saving") : t("pollMgr.saveType", { type: typeInSentence(draft.kind) })}</Button>
              <Button onClick={() => { setError(null); setDraft(null); }}>{t("pollMgr.cancel")}</Button>
            </div>
          </form>
        </Card>
      ) : eventLock ? null : (
        <div className="add-bar">
          <div className="row-actions">
            <AddContentMenu entries={ADD_BUTTONS} locks={lockedTypes} onPick={(kind) => { setError(null); if (kind === "survey") setSurvey(blankSurvey()); else setDraft(blank(kind, defaultModeration)); }} />
            <Button onClick={() => setPicking(true)}>{t("templates.addFrom")}</Button>
            {canManageTemplates && items.length > 0 && (
              <Button variant="quiet" onClick={() => setSaveTarget({ defaultName: eventName })}>{t("templates.saveEvent")}</Button>
            )}
          </div>
        </div>
      )}

      <SaveTemplateDialog
        eventId={eventId}
        target={saveTarget}
        onClose={() => setSaveTarget(null)}
        onSaved={(template) => {
          setSaveTarget(null);
          setTemplateNotice({ key: "templates.saved", name: template.name });
        }}
      />
      <TemplatePicker
        eventId={eventId}
        open={picking}
        canManage={canManageTemplates}
        onClose={() => setPicking(false)}
        onAdded={(template, added) => {
          setPicking(false);
          setItems((list) => [...list, ...(added as InteractionItem[])]);
          setTemplateNotice({ key: "templates.added", name: template.name });
        }}
      />

      <Dialog open={deleting !== null} title={t("pollMgr.deleteTitle")} onClose={() => setDeleting(null)}>
        <p>{t("pollMgr.deleteBody", { title: deleting?.title ?? "" })}</p>
        <div className="row-actions">
          <Button onClick={() => setDeleting(null)}>{t("pollMgr.cancel")}</Button>
          <Button variant="primary" onClick={() => deleting && remove(deleting)}>{t("pollMgr.deleteConfirm")}</Button>
        </div>
      </Dialog>
    </section>
  );
}
