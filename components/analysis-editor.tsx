"use client";

import { useState } from "react";
import { CATEGORY_NAME_MAX, SUMMARY_MAX, UNCATEGORIZED_NAME, type AnalysisEdit } from "@/lib/analysis-edit";
import { parseCategories, parseKeywords } from "@/components/presenter-analysis";

type Props = {
  summary: string | null;
  categories: unknown;
  keywords: unknown;
  notes: { id: string; text: string }[];
  /** Sends one edit; resolves to an error message, or null when it was saved. */
  onEdit: (edit: AnalysisEdit) => Promise<string | null>;
};

const buttonStyle = { padding: "0 12px", font: "inherit", minHeight: 44 } as const;
const fieldStyle = { font: "inherit", minHeight: 44, padding: "0 8px", boxSizing: "border-box" } as const;
const mutedStyle = { margin: "4px 0", color: "var(--ink-muted, #5c534b)" } as const;
const errorStyle = { margin: "4px 0", color: "var(--error, #9b1c1c)" } as const;
const ruleStyle = { borderTop: "1px solid var(--border, #e3dacb)", paddingTop: 8, marginTop: 12 } as const;

/** Host review of an AI result: summary, categories, notes and keywords. Every change is saved at once. */
export function AnalysisEditor({ summary, categories, keywords, notes, onEdit }: Props) {
  const cats = parseCategories(categories);
  const words = parseKeywords(keywords);
  const noteText = new Map(notes.map((n) => [n.id, n.text]));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);

  async function send(edit: AnalysisEdit) {
    setBusy(true);
    setError(null);
    const message = await onEdit(edit);
    setBusy(false);
    if (message) setError(message);
    return message === null;
  }

  async function saveSummary() {
    if (draft !== null && (await send({ op: "setSummary", summary: draft }))) setDraft(null);
  }

  async function saveRename() {
    if (renaming && (await send({ op: "renameCategory", name: renaming.name, to: renaming.value }))) setRenaming(null);
  }

  const targets = (except: string) => cats.filter((c) => c.name !== except);

  return (
    <div>
      {error && <p role="alert" style={errorStyle}>{error}</p>}

      {summary !== null && (
        <div style={ruleStyle}>
          <h4 style={{ margin: "0 0 4px" }}>Summary</h4>
          {draft === null ? (
            <>
              <p style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>{summary}</p>
              <button type="button" style={buttonStyle} onClick={() => setDraft(summary)}>Edit summary</button>
            </>
          ) : (
            <>
              <label htmlFor="analysis-summary" style={{ display: "block" }}>Summary text</label>
              <textarea
                id="analysis-summary"
                value={draft}
                maxLength={SUMMARY_MAX}
                rows={6}
                onChange={(e) => setDraft(e.target.value)}
                style={{ ...fieldStyle, width: "100%", padding: 8 }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => void saveSummary()}>Save summary</button>
                <button type="button" style={buttonStyle} onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {cats.length > 0 && (
        <div style={ruleStyle}>
          <h4 style={{ margin: "0 0 4px" }}>Categories</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {cats.map((c) => {
              const isUncategorized = c.name.toLowerCase() === UNCATEGORIZED_NAME.toLowerCase();
              const others = targets(c.name);
              return (
                <li key={c.name} style={{ marginBottom: 16 }}>
                  {renaming?.name === c.name ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
                      <div>
                        <label htmlFor="category-name" style={{ display: "block" }}>Category name</label>
                        <input
                          id="category-name"
                          value={renaming.value}
                          maxLength={CATEGORY_NAME_MAX}
                          onChange={(e) => setRenaming({ name: c.name, value: e.target.value })}
                          style={fieldStyle}
                        />
                      </div>
                      <button type="button" style={buttonStyle} disabled={busy} onClick={() => void saveRename()}>Save name</button>
                      <button type="button" style={buttonStyle} onClick={() => setRenaming(null)}>Cancel</button>
                    </div>
                  ) : (
                    <>
                      <strong>{c.name}</strong> <span style={mutedStyle}>({c.noteIds.length})</span>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "4px 0" }}>
                        <button type="button" style={buttonStyle} onClick={() => setRenaming({ name: c.name, value: c.name })}>
                          Rename<span className="sr-only"> {c.name}</span>
                        </button>
                        {others.length > 0 && (
                          <select
                            aria-label={`Merge ${c.name} into`}
                            value=""
                            disabled={busy}
                            onChange={(e) => e.target.value && void send({ op: "mergeCategories", from: c.name, into: e.target.value })}
                            style={fieldStyle}
                          >
                            <option value="">Merge into…</option>
                            {others.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
                          </select>
                        )}
                        {!isUncategorized && (
                          <button
                            type="button"
                            style={buttonStyle}
                            disabled={busy}
                            onClick={() => void send({ op: "deleteCategory", name: c.name })}
                          >
                            Delete<span className="sr-only"> {c.name}</span>
                          </button>
                        )}
                      </div>
                    </>
                  )}
                  <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
                    {c.noteIds.flatMap((id) => {
                      const text = noteText.get(id);
                      if (text === undefined) return [];
                      return [
                        <li key={id} style={{ margin: "6px 0" }}>
                          <span>{text}</span>{" "}
                          <select
                            aria-label={`Move note “${text.slice(0, 40)}” to`}
                            value=""
                            disabled={busy}
                            onChange={(e) => e.target.value && void send({ op: "moveNote", noteId: id, to: e.target.value })}
                            style={fieldStyle}
                          >
                            <option value="">Move to…</option>
                            {[...others, ...(isUncategorized || cats.some((o) => o.name === UNCATEGORIZED_NAME) ? [] : [{ name: UNCATEGORIZED_NAME }])].map((o) => (
                              <option key={o.name} value={o.name}>{o.name}</option>
                            ))}
                          </select>
                        </li>,
                      ];
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {words.length > 0 && (
        <div style={ruleStyle}>
          <h4 style={{ margin: "0 0 4px" }}>Keywords</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {words.map((k) => (
              <li key={k.word}>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy}
                  aria-label={`Remove keyword ${k.word}`}
                  onClick={() => void send({ op: "removeKeyword", word: k.word })}
                >
                  {k.word} ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
