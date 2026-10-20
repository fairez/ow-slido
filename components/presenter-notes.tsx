"use client";
import type { Socket } from "socket.io-client";

import { useState } from "react";
import {
  PresenterAnalysis,
  type AnalysisView,
} from "@/components/presenter-analysis";
import type { PublicNote } from "@/lib/shared-notes";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n";

type View = "top" | "newest";
type Tab = "notes" | AnalysisView;

const TABS: { id: Tab; label: MessageKey }[] = [
  { id: "notes", label: "presNotes.notes" },
  { id: "cloud", label: "presNotes.cloud" },
  { id: "categories", label: "presNotes.categories" },
  { id: "top", label: "presNotes.top" },
  { id: "summary", label: "presNotes.summary" },
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
  socket = null,
}: {
  interactionId: string;
  socket?: Socket | null;
  notes: PublicNote[];
  closed: boolean;
}) {
  const t = useT();
  const [view, setView] = useState<View>("top");
  const [tab, setTab] = useState<Tab>("notes");
  const ordered = orderNotes(notes, view);
  return (
    <>
      <p className="present-total">
        {t(notes.length === 1 ? "presNotes.count.one" : "presNotes.count.other", {
          n: notes.length,
          closed: closed ? t("presNotes.closed") : "",
        })}
      </p>
      <div role="group" aria-label={t("presNotes.viewLabel")} className="present-switch">
        {TABS.map((item) => (
          <button key={item.id} type="button" aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>
            {t(item.label)}
          </button>
        ))}
      </div>
      {tab !== "notes" && <PresenterAnalysis interactionId={interactionId} notes={notes} view={tab} socket={socket} />}
      {tab === "notes" && (
        <>
          <div role="group" aria-label={t("presNotes.orderLabel")} className="present-switch" data-small>
            {(["top", "newest"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
                {v === "top" ? t("presNotes.topUpvoted") : t("presNotes.newest")}
              </button>
            ))}
          </div>
          {ordered.length === 0 ? (
            <p role="status" className="present-empty">
              {t("presNotes.empty")}
            </p>
          ) : (
            <ul aria-label={t("presNotes.notes")} className="present-cards">
              {ordered.map((n) => (
                <li key={n.id} className="present-card" data-highlight={n.pinned || undefined}>
                  {n.pinned && <p className="present-card-label">{t("presNotes.pinned")}</p>}
                  <p className="present-card-text">{n.text}</p>
                  <p className="present-card-meta">
                    {n.authorName ? `${n.authorName} · ` : ""}
                    {t(n.upvotes === 1 ? "presNotes.upvote.one" : "presNotes.upvote.other", { n: n.upvotes })}
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
