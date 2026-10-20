"use client";

import { AnalysisSummary } from "@/components/analysis-summary";
import { useState } from "react";
import { CATEGORY_NAME_MAX, SUMMARY_MAX, UNCATEGORIZED_NAME, type AnalysisEdit } from "@/lib/analysis-edit";
import { Button } from "@/components/ui/button";
import { parseCategories, parseKeywords } from "@/components/presenter-analysis";
import { useT } from "@/lib/i18n/client";

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
  const t = useT();
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
          <h4>{t("analysisEditor.summary")}</h4>
          {draft === null ? (
            <>
              <AnalysisSummary text={summary} className="analysis-summary" />
              <div className="row-actions"><Button onClick={() => setDraft(summary)}>{t("analysisEditor.editSummary")}</Button></div>
            </>
          ) : (
            <>
              <label htmlFor="analysis-summary">{t("analysisEditor.summaryText")}</label>
              <textarea
                id="analysis-summary"
                value={draft}
                maxLength={SUMMARY_MAX}
                rows={6}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="row-actions">
                <Button variant="primary" busy={busy} onClick={() => void saveSummary()}>{t("analysisEditor.saveSummary")}</Button>
                <Button onClick={() => setDraft(null)}>{t("analysisEditor.cancel")}</Button>
              </div>
            </>
          )}
        </div>
      )}

      {cats.length > 0 && (
        <div className="analysis-part">
          <h4>{t("analysisEditor.categories")}</h4>
          <ul className="analysis-list">
            {cats.map((c) => {
              const isUncategorized = c.name.toLowerCase() === UNCATEGORIZED_NAME.toLowerCase();
              const others = targets(c.name);
              return (
                <li key={c.name} className="analysis-part">
                  {renaming?.name === c.name ? (
                    <div className="inline-form">
                      <div className="ui-field">
                        <label htmlFor="category-name">{t("analysisEditor.categoryName")}</label>
                        <input
                          id="category-name"
                          value={renaming.value}
                          maxLength={CATEGORY_NAME_MAX}
                          onChange={(e) => setRenaming({ name: c.name, value: e.target.value })}
                        />
                      </div>
                      <Button variant="primary" busy={busy} onClick={() => void saveRename()}>{t("analysisEditor.saveName")}</Button>
                      <Button onClick={() => setRenaming(null)}>{t("analysisEditor.cancel")}</Button>
                    </div>
                  ) : (
                    <>
                      <p>
                        <strong>{c.name}</strong> <span className="analysis-muted">({c.noteIds.length})</span>
                      </p>
                      <div className="row-actions">
                        <Button onClick={() => setRenaming({ name: c.name, value: c.name })}>
                          {t("analysisEditor.rename")}<span className="sr-only"> {c.name}</span>
                        </Button>
                        {others.length > 0 && (
                          <select
                            aria-label={t("analysisEditor.mergeAria", { name: c.name })}
                            value=""
                            disabled={busy}
                            onChange={(e) => e.target.value && void send({ op: "mergeCategories", from: c.name, into: e.target.value })}
                          >
                            <option value="">{t("analysisEditor.mergeInto")}</option>
                            {others.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
                          </select>
                        )}
                        {!isUncategorized && (
                          <Button disabled={busy} onClick={() => void send({ op: "deleteCategory", name: c.name })}>
                            {t("analysisEditor.delete")}<span className="sr-only"> {c.name}</span>
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
                            aria-label={t("analysisEditor.moveAria", { text: text.slice(0, 40) })}
                            value=""
                            disabled={busy}
                            onChange={(e) => e.target.value && void send({ op: "moveNote", noteId: id, to: e.target.value })}
                          >
                            <option value="">{t("analysisEditor.moveTo")}</option>
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
          <h4>{t("analysisEditor.keywords")}</h4>
          <ul className="analysis-list analysis-list-wrap">
            {words.map((k) => (
              <li key={k.word}>
                <Button disabled={busy} aria-label={t("analysisEditor.removeKeyword", { word: k.word })} onClick={() => void send({ op: "removeKeyword", word: k.word })}>
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
