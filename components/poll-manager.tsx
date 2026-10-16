"use client";

import { useState, type FormEvent } from "react";
import { WORDCLOUD_MAX_ENTRIES, WORDCLOUD_MIN_ENTRIES, WORDCLOUD_PROMPT_MAX } from "@/lib/wordcloud-limits";
import { INTERACTION_PROMPT_MAX, NOTES_MAX, NOTES_MIN, OPEN_TEXT_MAX, OPEN_TEXT_MIN } from "@/lib/interaction-config";
import { NotesAnalysisPanel } from "@/components/notes-analysis-panel";
import { OpenTextHostPanel } from "@/components/open-text-host-panel";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { InlineError, TextField, Toggle } from "@/components/ui/field";
import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX } from "@/lib/poll-limits";

export type InteractionItem = {
  id: string;
  type: "poll" | "wordcloud" | "sharedNotes" | "openText" | "rating";
  title: string;
  state: "draft" | "live" | "closed";
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
const TYPE_LABELS: Record<InteractionItem["type"], string> = {
  poll: "Poll",
  wordcloud: "Word cloud",
  sharedNotes: "Shared notes",
  openText: "Open text",
  rating: "Rating",
};

type Draft = { kind: Kind; scale: "stars5" | "numeric10"; maxResponses: number; maxNotes: number; moderated: boolean; showAuthors: boolean; maxEntries: number; id: string | null; question: string; options: { id?: string; label: string }[]; multiSelect: boolean; showResults: boolean };

const blank = (kind: Draft["kind"] = "poll"): Draft => ({ kind, scale: "stars5", maxResponses: 1, maxNotes: 3, moderated: false, showAuthors: false, maxEntries: 3, id: null, question: "", options: [{ label: "" }, { label: "" }], multiSelect: false, showResults: false });

async function errorFrom(response: Response) {
  const body = await response.json().catch(() => null);
  return body?.error ?? "Something went wrong. Please try again.";
}

const STATE_LABELS: Record<InteractionItem["state"], string> = { draft: "Draft", live: "Live", closed: "Closed" };

export function PollManager({ eventId, initialInteractions, aiEnabled = false }: { eventId: string; initialInteractions: InteractionItem[]; aiEnabled?: boolean }) {
  const base = `/api/events/${eventId}/interactions`;
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
      setError("Network error. Please try again.");
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

  async function transition(item: InteractionItem, action: "start" | "close") {
    const response = await call(`${base}/${item.id}/${action}`, { method: "POST" });
    if (!response) return;
    const { interaction } = (await response.json()) as { interaction: InteractionItem };
    // Starting closes the previously live interaction on the server.
    setItems((list) =>
      list.map((i) =>
        i.id === interaction.id ? interaction : action === "start" && i.state === "live" ? { ...i, state: "closed" } : i,
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
      <h2 id="interactions-title">Interactions</h2>
      {error && !draft && <InlineError>{error}</InlineError>}
      {items.length === 0 ? (
        <EmptyState title="Nothing to run yet">Add a poll, word cloud, shared notes, open text or rating below. Start one when your audience has joined.</EmptyState>
      ) : (
        <ul className="row-list">
          {items.map((item, index) => (
            <li key={item.id} className="interaction-row" data-state={item.state}>
              <div className="interaction-head">
                <div className="event-main">
                  <h3 className="event-name">{item.title}</h3>
                  <div className="row-meta">
                    {TYPE_LABELS[item.type]} <Badge tone={item.state === "live" ? "accent" : "neutral"}><span data-testid="state">{item.state}</span></Badge>
                  </div>
                </div>
                {item.state !== "closed" && (
                  <div className="row-actions">
                    {item.state === "draft" ? (
                      <Button variant="primary" onClick={() => transition(item, "start")}>Start</Button>
                    ) : (
                      <Button variant="primary" onClick={() => transition(item, "close")}>Close</Button>
                    )}
                  </div>
                )}
              </div>
              {item.type === "openText" && item.state !== "draft" && <OpenTextHostPanel eventId={eventId} interactionId={item.id} live={item.state === "live"} />}
              {item.type === "sharedNotes" && item.state !== "draft" && aiEnabled && <NotesAnalysisPanel interactionId={item.id} />}
              {item.state === "draft" && (
                <div className="row-actions row-actions-quiet">
                  <Button variant="quiet" onClick={() => edit(item)}>Edit</Button>
                  <Button variant="quiet" onClick={() => duplicate(item)}>Duplicate</Button>
                  <Button variant="quiet" onClick={() => setDeleting(item)}>Delete</Button>
                  <Button variant="quiet" aria-label={`Move ${item.title} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>
                  <Button variant="quiet" aria-label={`Move ${item.title} down`} disabled={index === items.length - 1} onClick={() => move(index, 1)}>↓</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <Card aria-labelledby="draft-title">
          <form onSubmit={save} className="form-stack">
            <h3 id="draft-title">{draft.id ? "Edit" : "New"} {TYPE_LABELS[draft.kind].toLowerCase()}</h3>
            <TextField
              label={draft.kind === "poll" ? "Question" : "Prompt"}
              value={draft.question}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
              required
              maxLength={maxLength}
            />
            {draft.kind === "poll" && (
              <fieldset className="form-group">
                <legend>Options</legend>
                {draft.options.map((option, index) => (
                  <div key={option.id ?? index} className="option-row">
                    <input
                      value={option.label}
                      onChange={(e) => setOption(index, e.target.value)}
                      aria-label={`Option ${index + 1}`}
                      required
                      maxLength={POLL_OPTION_MAX}
                    />
                    <Button
                      variant="quiet"
                      aria-label={`Remove option ${index + 1}`}
                      disabled={draft.options.length <= POLL_MIN_OPTIONS}
                      onClick={() => setDraft({ ...draft, options: draft.options.filter((_, i) => i !== index) })}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    disabled={draft.options.length >= POLL_MAX_OPTIONS}
                    onClick={() => setDraft({ ...draft, options: [...draft.options, { label: "" }] })}
                  >
                    Add option
                  </Button>
                </div>
                <Toggle label="Allow multiple selections" checked={draft.multiSelect} onChange={(e) => setDraft({ ...draft, multiSelect: e.target.checked })} />
                <Toggle label="Show results to participants" checked={draft.showResults} onChange={(e) => setDraft({ ...draft, showResults: e.target.checked })} />
              </fieldset>
            )}
            {draft.kind === "wordcloud" && numberField("Entries per participant", draft.maxEntries, WORDCLOUD_MIN_ENTRIES, WORDCLOUD_MAX_ENTRIES, (n) => setDraft({ ...draft, maxEntries: n }))}
            {draft.kind === "openText" && numberField("Responses per participant", draft.maxResponses, OPEN_TEXT_MIN, OPEN_TEXT_MAX, (n) => setDraft({ ...draft, maxResponses: n }))}
            {draft.kind === "rating" && (
              <fieldset className="form-group">
                <legend>Scale</legend>
                <label className="ui-toggle">
                  <input type="radio" name="scale" checked={draft.scale === "stars5"} onChange={() => setDraft({ ...draft, scale: "stars5" })} /> Stars, 1 to 5
                </label>
                <label className="ui-toggle">
                  <input type="radio" name="scale" checked={draft.scale === "numeric10"} onChange={() => setDraft({ ...draft, scale: "numeric10" })} /> Numbers, 1 to 10
                </label>
              </fieldset>
            )}
            {draft.kind === "sharedNotes" && (
              <>
                {numberField("Notes per participant", draft.maxNotes, NOTES_MIN, NOTES_MAX, (n) => setDraft({ ...draft, maxNotes: n }))}
                <fieldset className="form-group">
                  <legend>Moderation</legend>
                  <label className="ui-toggle">
                    <input type="radio" name="moderation" checked={!draft.moderated} onChange={() => setDraft({ ...draft, moderated: false })} /> Open: notes appear right away
                  </label>
                  <label className="ui-toggle">
                    <input type="radio" name="moderation" checked={draft.moderated} onChange={() => setDraft({ ...draft, moderated: true })} /> Moderated: notes wait for approval
                  </label>
                </fieldset>
                <Toggle label="Show author names" checked={draft.showAuthors} onChange={(e) => setDraft({ ...draft, showAuthors: e.target.checked })} />
              </>
            )}
            {error && <InlineError>{error}</InlineError>}
            <div className="row-actions">
              <Button type="submit" variant="primary" busy={pending}>{pending ? "Saving" : `Save ${TYPE_LABELS[draft.kind].toLowerCase()}`}</Button>
              <Button onClick={() => { setError(null); setDraft(null); }}>Cancel</Button>
            </div>
          </form>
        </Card>
      ) : (
        <div className="add-bar">
          <p className="row-meta">Add an interaction</p>
          <div className="row-actions">
            <Button onClick={() => setDraft(blank())}>New poll</Button>
            <Button onClick={() => setDraft(blank("wordcloud"))}>New word cloud</Button>
            <Button onClick={() => setDraft(blank("sharedNotes"))}>New shared notes</Button>
            <Button onClick={() => setDraft(blank("openText"))}>New open text</Button>
            <Button onClick={() => setDraft(blank("rating"))}>New rating</Button>
          </div>
        </div>
      )}

      <Dialog open={deleting !== null} title="Delete this interaction?" onClose={() => setDeleting(null)}>
        <p>“{deleting?.title}” will be removed from this event.</p>
        <div className="row-actions">
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => deleting && remove(deleting)}>Delete interaction</Button>
        </div>
      </Dialog>
    </section>
  );
}
