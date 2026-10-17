"use client";

import { AnalysisSummary } from "@/components/analysis-summary";
import { useState } from "react";
import { CATEGORY_NAME_MAX, SUMMARY_MAX, UNCATEGORIZED_NAME, type AnalysisEdit } from "@/lib/analysis-edit";
import { Button } from "@/components/ui/button";
import { parseCategories, parseKeywords } from "@/components/presenter-analysis";

type Props = {
  summary: string | null;
  categories: unknown;
  keywords: unknown;
  notes: { id: string; text: string }[];
  /** Sends one edit; resolves to an error message, or null when it was saved. */
  onEdit: (edit: AnalysisEdit) => Promise<string | null>;
};

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
    <div className="analysis-editor">
      {error && <p role="alert" className="analysis-error">{error}</p>}

      {summary !== null && (
        <div className="analysis-part">
          <h4>Summary</h4>
          {draft === null ? (
            <>
              <AnalysisSummary text={summary} className="analysis-summary" />
              <div className="row-actions"><Button onClick={() => setDraft(summary)}>Edit summary</Button></div>
            </>
          ) : (
            <>
              <label htmlFor="analysis-summary">Summary text</label>
              <textarea
                id="analysis-summary"
                value={draft}
                maxLength={SUMMARY_MAX}
                rows={6}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="row-actions">
                <Button variant="primary" busy={busy} onClick={() => void saveSummary()}>Save summary</Button>
                <Button onClick={() => setDraft(null)}>Cancel</Button>
              </div>
            </>
          )}
        </div>
      )}

      {cats.length > 0 && (
        <div className="analysis-part">
          <h4>Categories</h4>
          <ul className="analysis-list">
            {cats.map((c) => {
              const isUncategorized = c.name.toLowerCase() === UNCATEGORIZED_NAME.toLowerCase();
              const others = targets(c.name);
              return (
                <li key={c.name} className="analysis-part">
                  {renaming?.name === c.name ? (
                    <div className="inline-form">
                      <div className="ui-field">
                        <label htmlFor="category-name">Category name</label>
                        <input
                          id="category-name"
                          value={renaming.value}
                          maxLength={CATEGORY_NAME_MAX}
                          onChange={(e) => setRenaming({ name: c.name, value: e.target.value })}
                        />
                      </div>
                      <Button variant="primary" busy={busy} onClick={() => void saveRename()}>Save name</Button>
                      <Button onClick={() => setRenaming(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <>
                      <p>
                        <strong>{c.name}</strong> <span className="analysis-muted">({c.noteIds.length})</span>
                      </p>
                      <div className="row-actions">
                        <Button onClick={() => setRenaming({ name: c.name, value: c.name })}>
                          Rename<span className="sr-only"> {c.name}</span>
                        </Button>
                        {others.length > 0 && (
                          <select
                            aria-label={`Merge ${c.name} into`}
                            value=""
                            disabled={busy}
                            onChange={(e) => e.target.value && void send({ op: "mergeCategories", from: c.name, into: e.target.value })}
                          >
                            <option value="">Merge into…</option>
                            {others.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
                          </select>
                        )}
                        {!isUncategorized && (
                          <Button disabled={busy} onClick={() => void send({ op: "deleteCategory", name: c.name })}>
                            Delete<span className="sr-only"> {c.name}</span>
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                  <ul className="analysis-notes">
                    {c.noteIds.flatMap((id) => {
                      const text = noteText.get(id);
                      if (text === undefined) return [];
                      return [
                        <li key={id}>
                          <span>{text}</span>{" "}
                          <select
                            aria-label={`Move note “${text.slice(0, 40)}” to`}
                            value=""
                            disabled={busy}
                            onChange={(e) => e.target.value && void send({ op: "moveNote", noteId: id, to: e.target.value })}
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
        <div className="analysis-part">
          <h4>Keywords</h4>
          <ul className="analysis-list analysis-list-wrap">
            {words.map((k) => (
              <li key={k.word}>
                <Button disabled={busy} aria-label={`Remove keyword ${k.word}`} onClick={() => void send({ op: "removeKeyword", word: k.word })}>
                  {k.word} ×
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
