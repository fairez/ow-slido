"use client";

import { useState, type FormEvent } from "react";
import { WORDCLOUD_MAX_ENTRIES, WORDCLOUD_MIN_ENTRIES, WORDCLOUD_PROMPT_MAX } from "@/lib/wordcloud-limits";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { INTERACTION_PROMPT_MAX, NOTES_MAX, NOTES_MIN, OPEN_TEXT_MAX, OPEN_TEXT_MIN } from "@/lib/interaction-config";
import { NotesAnalysisPanel } from "@/components/notes-analysis-panel";
import { OpenTextHostPanel } from "@/components/open-text-host-panel";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { InlineError, TextField, Toggle } from "@/components/ui/field";
import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX } from "@/lib/poll-limits";
import { PlanHint } from "@/components/plan-hint";
import type { Lock } from "@/lib/plan-hints";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n";

export type InteractionItem = {
  id: string;
  type: "poll" | "wordcloud" | "sharedNotes" | "openText" | "rating";
  title: string;
  state: "draft" | "live" | "paused" | "closed";
  position: number;
  config: {
    options?: { id: string; label: string }[];
    multiSelect?: boolean;
    showResultsToParticipants?: boolean;
    prompt?: string;
    maxEntriesPerParticipant?: number;
    maxNotesPerParticipant?: number;
    moderation?: "open" | "moderated";
    showAuthorNames?: boolean;
    maxResponsesPerParticipant?: number;
    scale?: "stars5" | "numeric10";
  };
};

type Kind = "poll" | "wordcloud" | "sharedNotes" | "openText" | "rating";
const TYPE_LABELS: Record<InteractionItem["type"], MessageKey> = {
  poll: "pollMgr.type.poll",
  wordcloud: "pollMgr.type.wordcloud",
  sharedNotes: "pollMgr.type.sharedNotes",
  openText: "pollMgr.type.openText",
  rating: "pollMgr.type.rating",
};

const ADD_BUTTONS: { kind: Kind; label: MessageKey }[] = [
  { kind: "poll", label: "pollMgr.newPoll" },
  { kind: "wordcloud", label: "pollMgr.newWordcloud" },
  { kind: "sharedNotes", label: "pollMgr.newSharedNotes" },
  { kind: "openText", label: "pollMgr.newOpenText" },
  { kind: "rating", label: "pollMgr.newRating" },
];

type Draft = { kind: Kind; scale: "stars5" | "numeric10"; maxResponses: number; maxNotes: number; moderated: boolean; showAuthors: boolean; maxEntries: number; id: string | null; question: string; options: { id?: string; label: string }[]; multiSelect: boolean; showResults: boolean };

const blank = (kind: Draft["kind"] = "poll"): Draft => ({ kind, scale: "stars5", maxResponses: 1, maxNotes: 3, moderated: false, showAuthors: false, maxEntries: 3, id: null, question: "", options: [{ label: "" }, { label: "" }], multiSelect: false, showResults: false });

async function errorFrom(response: Response) {
  const body = await response.json().catch(() => null);
  return body?.error ?? SERVER_ERROR;
}

type PollManagerProps = {
  eventId: string;
  initialInteractions: InteractionItem[];
  aiEnabled?: boolean;
  /** Types the plan leaves out; their add buttons turn into a pointer to the plan page. */
  lockedTypes?: Partial<Record<Kind, Lock>>;
  /** Set when the plan has no AI calls: the analysis button turns into a pointer to the plan page. */
  aiLock?: Lock;
  /** Interactions a downgrade left read-only, by id: they keep their results but cannot be started, edited or duplicated. */
  itemLocks?: Record<string, Lock>;
  /** Set when the whole event is past the plan's monthly limit: nothing new can be added to it. */
  eventLock?: Lock;
};

export function PollManager({ eventId, initialInteractions, aiEnabled = false, lockedTypes = {}, aiLock, itemLocks = {}, eventLock }: PollManagerProps) {
  const t = useT();
  const typeLabel = (kind: Kind) => t(TYPE_LABELS[kind]);
  const base = `/api/events/${eventId}/interactions`;
  // Only needed for live analysis status; stays disconnected when AI is off.
  const { socket } = useEventSocket(eventId, "host", aiEnabled);
  const [items, setItems] = useState(initialInteractions);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState<InteractionItem | null>(null);

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

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const body =
      draft.kind === "rating"
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

  async function move(index: number, delta: -1 | 1) {
    const next = [...items];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    const response = await call(`${base}/reorder`, json({ ids: next.map((i) => i.id) }));
    if (response) setItems(next);
  }

  function edit(item: InteractionItem) {
    setError(null);
    setDraft({
      kind: item.type,
      scale: item.config.scale ?? "stars5",
      maxResponses: item.config.maxResponsesPerParticipant ?? 1,
      maxNotes: item.config.maxNotesPerParticipant ?? 3,
      moderated: item.config.moderation === "moderated",
      showAuthors: item.config.showAuthorNames ?? false,
      maxEntries: item.config.maxEntriesPerParticipant ?? 3,
      id: item.id,
      question: item.title,
      options: (item.config.options ?? []).map((o) => ({ id: o.id, label: o.label })),
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
      {error && !draft && <InlineError>{error}</InlineError>}
      {items.length === 0 ? (
        <EmptyState title={t("pollMgr.emptyTitle")}>{t("pollMgr.emptyBody")}</EmptyState>
      ) : (
        <ul className="row-list">
          {items.map((item, index) => {
            const lock = itemLocks[item.id];
            return (
            <li key={item.id} className="interaction-row" data-state={item.state}>
              <div className="interaction-head">
                <div className="event-main">
                  <h3 className="event-name">{item.title}</h3>
                  <div className="row-meta">
                    {typeLabel(item.type)} <Badge tone={item.state === "live" ? "accent" : "neutral"}><span data-testid="state">{item.state}</span></Badge>
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
              {item.state === "draft" && (
                <div className="row-actions row-actions-quiet">
                  {!lock && <Button variant="quiet" onClick={() => edit(item)}>{t("pollMgr.edit")}</Button>}
                  {!lock && <Button variant="quiet" onClick={() => duplicate(item)}>{t("pollMgr.duplicate")}</Button>}
                  <Button variant="quiet" onClick={() => setDeleting(item)}>{t("pollMgr.delete")}</Button>
                  {!eventLock && <Button variant="quiet" aria-label={t("pollMgr.moveUp", { title: item.title })} disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>}
                  {!eventLock && <Button variant="quiet" aria-label={t("pollMgr.moveDown", { title: item.title })} disabled={index === items.length - 1} onClick={() => move(index, 1)}>↓</Button>}
                </div>
              )}
            </li>
            );
          })}
        </ul>
      )}

      {draft ? (
        <Card aria-labelledby="draft-title">
          <form onSubmit={save} className="form-stack">
            <h3 id="draft-title">{t(draft.id ? "pollMgr.editType" : "pollMgr.newType", { type: typeLabel(draft.kind).toLowerCase() })}</h3>
            <TextField
              label={draft.kind === "poll" ? t("pollMgr.question") : t("pollMgr.prompt")}
              value={draft.question}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
              required
              maxLength={maxLength}
            />
            {draft.kind === "poll" && (
              <fieldset className="form-group">
                <legend>{t("pollMgr.options")}</legend>
                {draft.options.map((option, index) => (
                  <div key={option.id ?? index} className="option-row">
                    <input
                      value={option.label}
                      onChange={(e) => setOption(index, e.target.value)}
                      aria-label={t("pollMgr.optionN", { n: index + 1 })}
                      required
                      maxLength={POLL_OPTION_MAX}
                    />
                    <Button
                      variant="quiet"
                      aria-label={t("pollMgr.removeOptionN", { n: index + 1 })}
                      disabled={draft.options.length <= POLL_MIN_OPTIONS}
                      onClick={() => setDraft({ ...draft, options: draft.options.filter((_, i) => i !== index) })}
                    >
                      {t("pollMgr.remove")}
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    disabled={draft.options.length >= POLL_MAX_OPTIONS}
                    onClick={() => setDraft({ ...draft, options: [...draft.options, { label: "" }] })}
                  >
                    {t("pollMgr.addOption")}
                  </Button>
                </div>
                <Toggle label={t("pollMgr.multiSelect")} checked={draft.multiSelect} onChange={(e) => setDraft({ ...draft, multiSelect: e.target.checked })} />
                <Toggle label={t("pollMgr.showResults")} checked={draft.showResults} onChange={(e) => setDraft({ ...draft, showResults: e.target.checked })} />
              </fieldset>
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
              <Button type="submit" variant="primary" busy={pending}>{pending ? t("pollMgr.saving") : t("pollMgr.saveType", { type: typeLabel(draft.kind).toLowerCase() })}</Button>
              <Button onClick={() => { setError(null); setDraft(null); }}>{t("pollMgr.cancel")}</Button>
            </div>
          </form>
        </Card>
      ) : eventLock ? null : (
        <div className="add-bar">
          <p className="row-meta">{t("pollMgr.addBar")}</p>
          <div className="row-actions">
            {ADD_BUTTONS.map(({ kind, label }) => {
              const lock = lockedTypes[kind];
              return lock ? (
                <PlanHint key={kind} lock={lock}>{t(label)}</PlanHint>
              ) : (
                <Button key={kind} onClick={() => setDraft(blank(kind))}>{t(label)}</Button>
              );
            })}
          </div>
        </div>
      )}

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
