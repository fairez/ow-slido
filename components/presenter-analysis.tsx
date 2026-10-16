"use client";

import { useEffect, useMemo, useState } from "react";
import { WordCloud } from "@/components/word-cloud";
import { fallbackKeywords, type AnalysisKeyword } from "@/lib/note-keywords";
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
  return raw.flatMap((k) =>
    isRecord(k) && typeof k.word === "string" && typeof k.weight === "number"
      ? [{ word: k.word, weight: k.weight }]
      : [],
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

const badgeStyle = {
  display: "inline-block",
  border: "1px solid currentColor",
  borderRadius: 4,
  padding: "2px 8px",
  fontSize: "1rem",
} as const;

function AiLabel({ outdated }: { outdated: boolean }) {
  return (
    <p
      style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 16px" }}
    >
      <span style={badgeStyle}>AI-generated</span>
      {outdated && (
        <span style={badgeStyle}>
          Outdated: notes have changed since this analysis
        </span>
      )}
    </p>
  );
}

function NoteList({ notes }: { notes: PublicNote[] }) {
  return (
    <ul
      style={{
        listStyle: "none",
        padding: 0,
        margin: 0,
        display: "grid",
        gap: 12,
      }}
    >
      {notes.map((n) => (
        <li
          key={n.id}
          style={{
            padding: 12,
            border: "2px solid var(--border, currentColor)",
            overflowWrap: "anywhere",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "1.75rem",
              lineHeight: 1.3,
              whiteSpace: "pre-wrap",
            }}
          >
            {n.text}
          </p>
          <p style={{ margin: "8px 0 0", fontSize: "1.25rem" }}>
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
      <ol
        aria-label="Categories"
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "grid",
          gap: 12,
        }}
      >
        {rows.map(({ c, list }) => {
          const percent =
            total > 0 ? Math.round((list.length / total) * 100) : 0;
          return (
            <li key={c.name}>
              <button
                type="button"
                aria-expanded={open === c.name}
                onClick={() => setOpen(open === c.name ? null : c.name)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  alignItems: "baseline",
                  gap: "4px 12px",
                  width: "100%",
                  minHeight: 44,
                  padding: 0,
                  font: "inherit",
                  fontSize: "1.75rem",
                  color: "inherit",
                  background: "none",
                  border: "none",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <span style={{ fontWeight: 700, overflowWrap: "anywhere" }}>
                  {c.name}
                </span>
                <span
                  aria-hidden="true"
                  style={{
                    display: "block",
                    gridColumn: "1 / -1",
                    gridRow: 2,
                    height: 28,
                    border: "1px solid var(--border, currentColor)",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      height: "100%",
                      width: `${(list.length / max) * 100}%`,
                      background:
                        list.length === lead
                          ? "var(--accent, #b5472b)"
                          : "color-mix(in srgb, var(--ink, currentColor) 45%, transparent)",
                    }}
                  />
                </span>
                <span style={{ gridColumn: 2, gridRow: 1, textAlign: "right" }}>
                  {list.length} ({percent}%)
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {selected && (
        <section
          aria-label={`Notes in ${selected.c.name}`}
          style={{ marginTop: 24 }}
        >
          <h2 style={{ fontSize: "2rem", margin: "0 0 4px" }}>
            {selected.c.name}
          </h2>
          {selected.c.description && (
            <p style={{ fontSize: "1.25rem", margin: "0 0 12px" }}>
              {selected.c.description}
            </p>
          )}
          {selected.list.length === 0 ? (
            <p style={{ fontSize: "1.5rem" }}>
              No notes left in this category.
            </p>
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
    <div style={{ display: "grid", gap: 32 }}>
      {categories.map((c) => {
        const top = categoryNotes(c, notes).slice(0, 3);
        return (
          <section key={c.name} aria-label={c.name}>
            <h2 style={{ fontSize: "2rem", margin: "0 0 12px" }}>{c.name}</h2>
            {top.length === 0 ? (
              <p style={{ fontSize: "1.5rem", margin: 0 }}>
                No notes left in this category.
              </p>
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
}: {
  interactionId: string;
  notes: PublicNote[];
  view: AnalysisView;
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

  // Refetch on note changes and tab switches, and every 10s so a run started on the event page shows up here.
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
    const poll = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [interactionId, signature, view]);

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
          <p style={{ fontSize: "1.25rem", margin: "0 0 16px" }}>
            Word frequency across the notes. Not AI-generated.
          </p>
        )}
        <WordCloud words={words} />
      </>
    );
  }

  if (!analysis) {
    return (
      <p role="status" style={{ fontSize: "2rem" }}>
        {failed ? "Could not load the analysis." : noAnalysis}
      </p>
    );
  }

  if (view === "summary") {
    return (
      <>
        <AiLabel outdated={outdated} />
        {analysis.summary ? (
          <p
            style={{
              fontSize: "2rem",
              lineHeight: 1.4,
              maxWidth: "60ch",
              margin: 0,
              whiteSpace: "pre-wrap",
            }}
          >
            {analysis.summary}
          </p>
        ) : (
          <p role="status" style={{ fontSize: "2rem" }}>
            This run produced keywords only, so there is no summary.
          </p>
        )}
      </>
    );
  }

  if (categories.length === 0) {
    return (
      <p role="status" style={{ fontSize: "2rem" }}>
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
