"use client";
import { AnalysisSummary } from "@/components/analysis-summary";
import type { Socket } from "socket.io-client";

import { useEffect, useMemo, useState } from "react";
import { WordCloud } from "@/components/word-cloud";
import { fallbackKeywords, normalizeKeywords, type AnalysisKeyword } from "@/lib/note-keywords";
import type { PublicNote } from "@/lib/shared-notes";

export type AnalysisView = "cloud" | "categories" | "top" | "summary";

type Category = { name: string; description: string; noteIds: string[] };
type Analysis = {
  summary: string | null;
  categories: unknown;
  keywords: unknown;
  outdated: boolean;
  model: string | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export function parseCategories(raw: unknown): Category[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) =>
    isRecord(c) && typeof c.name === "string" && Array.isArray(c.noteIds)
      ? [
          {
            name: c.name,
            description: typeof c.description === "string" ? c.description : "",
            noteIds: c.noteIds.filter(
              (x): x is string => typeof x === "string",
            ),
          },
        ]
      : [],
  );
}

export function parseKeywords(raw: unknown): AnalysisKeyword[] {
  if (!Array.isArray(raw)) return [];
  return normalizeKeywords(
    raw.flatMap((k) =>
      isRecord(k) && typeof k.word === "string" && typeof k.weight === "number"
        ? [{ word: k.word, weight: k.weight }]
        : [],
    ),
  );
}

/** Notes of a category that still exist, most upvoted first (ties: newest). */
export function categoryNotes(
  category: Category,
  notes: PublicNote[],
): PublicNote[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  return category.noteIds
    .flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
    .sort(
      (a, b) => b.upvotes - a.upvotes || b.createdAt.localeCompare(a.createdAt),
    );
}

function AiLabel({ outdated }: { outdated: boolean }) {
  return (
    <p className="present-ai">
      <span className="ui-badge">AI-generated</span>
      {outdated && <span className="ui-badge">Outdated: notes have changed since this analysis</span>}
    </p>
  );
}

function NoteList({ notes }: { notes: PublicNote[] }) {
  return (
    <ul className="present-cards" data-stack>
      {notes.map((n) => (
        <li key={n.id} className="present-card">
          <p className="present-card-text">{n.text}</p>
          <p className="present-card-meta">
            {n.upvotes} {n.upvotes === 1 ? "upvote" : "upvotes"}
          </p>
        </li>
      ))}
    </ul>
  );
}

function CategoryChart({
  categories,
  notes,
}: {
  categories: Category[];
  notes: PublicNote[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = categories.map((c) => ({ c, list: categoryNotes(c, notes) }));
  const total = rows.reduce((sum, r) => sum + r.list.length, 0);
  const max = Math.max(1, ...rows.map((r) => r.list.length));
  const lead = Math.max(...rows.map((r) => r.list.length));
  const selected = rows.find((r) => r.c.name === open);
  return (
    <>
      <ol aria-label="Categories" className="present-bars">
        {rows.map(({ c, list }) => {
          const percent = total > 0 ? Math.round((list.length / total) * 100) : 0;
          return (
            <li key={c.name}>
              <button
                type="button"
                className="present-category"
                aria-expanded={open === c.name}
                onClick={() => setOpen(open === c.name ? null : c.name)}
              >
                <span className="present-category-name">{c.name}</span>
                <span className="present-category-count">
                  {list.length} ({percent}%)
                </span>
                <span aria-hidden="true" className="present-track">
                  <span className="present-fill" data-leading={list.length > 0 && list.length === lead} style={{ width: `${(list.length / max) * 100}%` }} />
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {selected && (
        <section aria-label={`Notes in ${selected.c.name}`} className="present-section">
          <h2 className="present-subtitle">{selected.c.name}</h2>
          {selected.c.description && <p className="present-desc">{selected.c.description}</p>}
          {selected.list.length === 0 ? (
            <p className="present-empty">No notes left in this category.</p>
          ) : (
            <NoteList notes={selected.list} />
          )}
        </section>
      )}
    </>
  );
}

function TopNotes({
  categories,
  notes,
}: {
  categories: Category[];
  notes: PublicNote[];
}) {
  return (
    <div className="present-groups">
      {categories.map((c) => {
        const top = categoryNotes(c, notes).slice(0, 3);
        return (
          <section key={c.name} aria-label={c.name}>
            <h2 className="present-subtitle">{c.name}</h2>
            {top.length === 0 ? (
              <p className="present-empty">No notes left in this category.</p>
            ) : (
              <NoteList notes={top} />
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Word cloud, category chart, top notes per category and summary for one notes interaction, with an AI-generated label. */
export function PresenterAnalysis({
  interactionId,
  notes,
  view,
  socket = null,
}: {
  interactionId: string;
  notes: PublicNote[];
  view: AnalysisView;
  socket?: Socket | null;
}) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [failed, setFailed] = useState(false);
  // Refetch when the approved notes change so the "outdated" state follows the board.
  const signature = useMemo(
    () =>
      notes
        .map((n) => `${n.id}:${n.text.length}`)
        .sort()
        .join(","),
    [notes],
  );

  // Refetch on note changes and tab switches. A run started on the event page arrives as an
  // `analysis:updated` message; the slow poll only covers a missed message or no socket.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/interactions/${interactionId}/analysis`);
        if (!res.ok) throw new Error();
        const body = (await res.json()) as { lastDone: Analysis | null };
        if (!cancelled) {
          setAnalysis(body.lastDone);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    const first = setTimeout(() => void load(), 500);
    const poll = setInterval(() => void load(), socket ? 60_000 : 10_000);
    const onUpdated = (msg: { interactionId: string }) => {
      if (msg.interactionId === interactionId) void load();
    };
    const onConnect = () => void load();
    socket?.on("analysis:updated", onUpdated);
    socket?.on("connect", onConnect);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(poll);
      socket?.off("analysis:updated", onUpdated);
      socket?.off("connect", onConnect);
    };
  }, [interactionId, signature, view, socket]);

  const categories = parseCategories(analysis?.categories);
  const aiKeywords = parseKeywords(analysis?.keywords);
  const outdated = analysis?.outdated ?? false;
  const noAnalysis =
    "No analysis yet. Run one from the event page, then come back to this view.";

  if (view === "cloud") {
    const fromAi = aiKeywords.length > 0;
    const words = (fromAi ? aiKeywords : fallbackKeywords(notes)).map((k) => ({
      word: k.word,
      count: k.weight,
    }));
    return (
      <>
        {fromAi ? (
          <AiLabel outdated={outdated} />
        ) : (
          <p className="present-desc">Word frequency across the notes. Not AI-generated.</p>
        )}
        <WordCloud words={words} />
      </>
    );
  }

  if (!analysis) {
    return (
      <p role="status" className="present-empty">
        {failed ? "Could not load the analysis." : noAnalysis}
      </p>
    );
  }

  if (view === "summary") {
    return (
      <>
        <AiLabel outdated={outdated} />
        {analysis.summary ? (
          <AnalysisSummary text={analysis.summary} className="present-summary" />
        ) : (
          <p role="status" className="present-empty">
            This run produced keywords only, so there is no summary.
          </p>
        )}
      </>
    );
  }

  if (categories.length === 0) {
    return (
      <p role="status" className="present-empty">
        This run produced keywords only, so there are no categories.
      </p>
    );
  }
  return (
    <>
      <AiLabel outdated={outdated} />
      {view === "categories" ? (
        <CategoryChart categories={categories} notes={notes} />
      ) : (
        <TopNotes categories={categories} notes={notes} />
      )}
    </>
  );
}
