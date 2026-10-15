"use client";

import { useState, type FormEvent } from "react";
import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX } from "@/lib/poll-limits";

export type InteractionItem = {
  id: string;
  type: "poll" | "wordcloud";
  title: string;
  state: "draft" | "live" | "closed";
  position: number;
  config: {
    options?: { id: string; label: string }[];
    multiSelect?: boolean;
    showResultsToParticipants?: boolean;
  };
};

type Draft = { id: string | null; question: string; options: { id?: string; label: string }[]; multiSelect: boolean; showResults: boolean };

const blank = (): Draft => ({ id: null, question: "", options: [{ label: "" }, { label: "" }], multiSelect: false, showResults: false });

async function errorFrom(response: Response) {
  const body = await response.json().catch(() => null);
  return body?.error ?? "Something went wrong. Please try again.";
}

const inputStyle = { padding: 8, font: "inherit", minHeight: 44 } as const;
const buttonStyle = { padding: 10, font: "inherit", minHeight: 44 } as const;

export function PollManager({ eventId, initialInteractions }: { eventId: string; initialInteractions: InteractionItem[] }) {
  const base = `/api/events/${eventId}/interactions`;
  const [items, setItems] = useState(initialInteractions);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
    const body = {
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
    if (!window.confirm(`Delete “${item.title}”?`)) return;
    const response = await call(`${base}/${item.id}`, { method: "DELETE" });
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

  return (
    <section>
      <h2>Interactions</h2>
      {error && (
        <p role="alert" style={{ color: "#b00020" }}>
          {error}
        </p>
      )}
      {items.length === 0 ? (
        <p>No interactions yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
          {items.map((item, index) => (
            <li key={item.id} style={{ border: "1px solid #ccc", padding: 12 }}>
              <strong>{item.title}</strong>
              <div>
                {item.type} · <span data-testid="state">{item.state}</span>
              </div>
              {item.state !== "closed" && (
                <div style={{ marginTop: 8 }}>
                  {item.state === "draft" ? (
                    <button type="button" onClick={() => transition(item, "start")} style={buttonStyle}>Start</button>
                  ) : (
                    <button type="button" onClick={() => transition(item, "close")} style={buttonStyle}>Close</button>
                  )}
                </div>
              )}
              {item.state === "draft" && (
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => edit(item)} style={buttonStyle}>Edit</button>
                  <button type="button" onClick={() => duplicate(item)} style={buttonStyle}>Duplicate</button>
                  <button type="button" onClick={() => remove(item)} style={buttonStyle}>Delete</button>
                  <button type="button" aria-label={`Move ${item.title} up`} disabled={index === 0} onClick={() => move(index, -1)} style={buttonStyle}>↑</button>
                  <button type="button" aria-label={`Move ${item.title} down`} disabled={index === items.length - 1} onClick={() => move(index, 1)} style={buttonStyle}>↓</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <form onSubmit={save} style={{ display: "grid", gap: 12, maxWidth: 480, marginTop: 16 }}>
          <h3>{draft.id ? "Edit poll" : "New poll"}</h3>
          <label style={{ display: "grid", gap: 4 }}>
            Question
            <input
              value={draft.question}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
              required
              maxLength={POLL_QUESTION_MAX}
              style={inputStyle}
            />
          </label>
          {draft.options.map((option, index) => (
            <div key={option.id ?? index} style={{ display: "flex", gap: 8 }}>
              <input
                value={option.label}
                onChange={(e) => setOption(index, e.target.value)}
                aria-label={`Option ${index + 1}`}
                required
                maxLength={POLL_OPTION_MAX}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                aria-label={`Remove option ${index + 1}`}
                disabled={draft.options.length <= POLL_MIN_OPTIONS}
                onClick={() => setDraft({ ...draft, options: draft.options.filter((_, i) => i !== index) })}
                style={buttonStyle}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={draft.options.length >= POLL_MAX_OPTIONS}
            onClick={() => setDraft({ ...draft, options: [...draft.options, { label: "" }] })}
            style={buttonStyle}
          >
            Add option
          </button>
          <label>
            <input type="checkbox" checked={draft.multiSelect} onChange={(e) => setDraft({ ...draft, multiSelect: e.target.checked })} /> Allow multiple selections
          </label>
          <label>
            <input type="checkbox" checked={draft.showResults} onChange={(e) => setDraft({ ...draft, showResults: e.target.checked })} /> Show results to participants
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={pending} style={buttonStyle}>{pending ? "Saving…" : "Save poll"}</button>
            <button type="button" onClick={() => setDraft(null)} style={buttonStyle}>Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setDraft(blank())} style={{ ...buttonStyle, marginTop: 16 }}>
          New poll
        </button>
      )}
    </section>
  );
}
