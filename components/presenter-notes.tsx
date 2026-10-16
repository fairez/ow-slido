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

const pressed = (on: boolean) =>
  ({
    minHeight: 44,
    padding: "0 16px",
    fontSize: "1.25rem",
    fontWeight: on ? 700 : 400,
    background: on ? "#fff" : "transparent",
    color: on ? "#000" : "#fff",
    border: "2px solid #fff",
  }) as const;

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
      <p style={{ fontSize: "2rem", margin: "0 0 16px" }}>
        {notes.length} {notes.length === 1 ? "note" : "notes"}
        {closed ? " (closed)" : ""}
      </p>
      <div
        role="group"
        aria-label="Presenter view"
        style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
            style={pressed(tab === t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab !== "notes" && (
        <PresenterAnalysis
          interactionId={interactionId}
          notes={notes}
          view={tab}
        />
      )}
      {tab === "notes" && (
        <>
          <div
            role="group"
            aria-label="Order notes by"
            style={{ display: "flex", gap: 8, marginBottom: 24 }}
          >
            {(["top", "newest"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                style={{
                  minHeight: 44,
                  padding: "0 16px",
                  fontSize: "1.25rem",
                  fontWeight: view === v ? 700 : 400,
                  background: view === v ? "#fff" : "transparent",
                  color: view === v ? "#000" : "#fff",
                  border: "2px solid #fff",
                }}
              >
                {v === "top" ? "Top upvoted" : "Newest"}
              </button>
            ))}
          </div>
          {ordered.length === 0 ? (
            <p role="status" style={{ fontSize: "2rem" }}>
              No notes yet
            </p>
          ) : (
            <ul
              aria-label="Notes"
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(min(100%, 320px), 1fr))",
                alignItems: "start",
                gap: 16,
              }}
            >
              {ordered.map((n) => (
                <li
                  key={n.id}
                  style={{
                    padding: 16,
                    border: n.pinned ? "4px solid #ffd400" : "2px solid #fff",
                    overflowWrap: "anywhere",
                    minWidth: 0,
                  }}
                >
                  {n.pinned && (
                    <p
                      style={{
                        margin: "0 0 8px",
                        fontSize: "1rem",
                        fontWeight: 700,
                        color: "#ffd400",
                      }}
                    >
                      Pinned
                    </p>
                  )}
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
                  <p style={{ margin: "12px 0 0", fontSize: "1.25rem" }}>
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
