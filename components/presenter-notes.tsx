"use client";

import { useState } from "react";
import {
  PresenterAnalysis,
  type AnalysisView,
} from "@/components/presenter-analysis";
import type { PublicNote } from "@/lib/shared-notes";

type View = "top" | "newest";
type Tab = "notes" | AnalysisView;

const TABS: { id: Tab; label: string }[] = [
  { id: "notes", label: "Notes" },
  { id: "cloud", label: "Word cloud" },
  { id: "categories", label: "Categories" },
  { id: "top", label: "Top notes by category" },
  { id: "summary", label: "Summary" },
];

/** Pinned notes first, then by the chosen view; ties fall back to newest. */
export function orderNotes(notes: PublicNote[], view: View): PublicNote[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const newest = b.createdAt.localeCompare(a.createdAt);
    return view === "newest" ? newest : b.upvotes - a.upvotes || newest;
  });
}

/** Notes for the projector: large type, pinned notes marked, switchable between Top upvoted and Newest. */
export function PresenterNotes({
  interactionId,
  notes,
  closed,
}: {
  interactionId: string;
  notes: PublicNote[];
  closed: boolean;
}) {
  const [view, setView] = useState<View>("top");
  const [tab, setTab] = useState<Tab>("notes");
  const ordered = orderNotes(notes, view);
  return (
    <>
      <p className="present-total">
        {notes.length} {notes.length === 1 ? "note" : "notes"}
        {closed ? " (closed)" : ""}
      </p>
      <div role="group" aria-label="Presenter view" className="present-switch">
        {TABS.map((t) => (
          <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab !== "notes" && <PresenterAnalysis interactionId={interactionId} notes={notes} view={tab} />}
      {tab === "notes" && (
        <>
          <div role="group" aria-label="Order notes by" className="present-switch" data-small>
            {(["top", "newest"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
                {v === "top" ? "Top upvoted" : "Newest"}
              </button>
            ))}
          </div>
          {ordered.length === 0 ? (
            <p role="status" className="present-empty">
              No notes yet
            </p>
          ) : (
            <ul aria-label="Notes" className="present-cards">
              {ordered.map((n) => (
                <li key={n.id} className="present-card" data-highlight={n.pinned || undefined}>
                  {n.pinned && <p className="present-card-label">Pinned</p>}
                  <p className="present-card-text">{n.text}</p>
                  <p className="present-card-meta">
                    {n.authorName ? `${n.authorName} · ` : ""}
                    {n.upvotes} {n.upvotes === 1 ? "upvote" : "upvotes"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
