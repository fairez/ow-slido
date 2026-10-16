"use client";

import { useCallback, useEffect, useState } from "react";

type Analysis = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  noteCount: number;
  summary: string | null;
  edited: boolean;
  published: boolean;
  model: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  outdated: boolean;
};

type State = { analysis: Analysis | null; lastDone: Analysis | null; approvedNoteCount: number; noticeAccepted: boolean };

const buttonStyle = { padding: "0 12px", font: "inherit", minHeight: 44 } as const;
const mutedStyle = { margin: "4px 0", color: "var(--ink-muted, #5c534b)" } as const;
const errorStyle = { margin: "4px 0", color: "var(--error, #9b1c1c)" } as const;

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Host controls for the AI analysis of one shared-notes interaction. Rendered only when AI is configured. */
export function NotesAnalysisPanel({ interactionId }: { interactionId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/interactions/${interactionId}/analysis`);
      if (!res.ok) return setError("Could not load the analysis.");
      setState((await res.json()) as State);
    } catch {
      setError("Could not load the analysis.");
    }
  }, [interactionId]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const running = state?.analysis?.status === "queued" || state?.analysis?.status === "running";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [running, load]);

  async function run() {
    if (!state) return;
    if (state.lastDone?.edited && !window.confirm("You edited the last analysis. Running again replaces your edits. Continue?")) return;
    setError(null);
    setStarting(true);
    try {
      const res = await fetch(`/api/interactions/${interactionId}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptNotice: accepted }),
      });
      if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Something went wrong. Please try again.");
      await load();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setStarting(false);
    }
  }

  async function setPublished(published: boolean) {
    setError(null);
    try {
      const res = await fetch(`/api/interactions/${interactionId}/analysis`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ published }),
      });
      if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Something went wrong. Please try again.");
      await load();
    } catch {
      setError("Network error. Please try again.");
    }
  }

  if (!state) return error ? <p role="alert" style={errorStyle}>{error}</p> : null;

  const { analysis, lastDone, approvedNoteCount, noticeAccepted } = state;
  const needsNotice = !noticeAccepted;
  const noNotes = approvedNoteCount === 0;
  const disabled = running || starting || noNotes || (needsNotice && !accepted);
  const shown = lastDone;
  const keywordsOnly = shown !== null && shown.status === "done" && !shown.summary;
  const label = shown ? "Run again" : "Analyze notes";

  return (
    <section aria-label="Analyze notes" style={{ marginTop: 12, paddingTop: 8, borderTop: "1px solid var(--border, #e3dacb)" }}>
      <h3 style={{ fontSize: "1rem", margin: 0 }}>Analysis</h3>
      <p style={mutedStyle}>
        {approvedNoteCount} approved {approvedNoteCount === 1 ? "note" : "notes"}
      </p>
      {needsNotice && (
        <label style={{ display: "block", margin: "8px 0" }}>
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> I understand that the text of approved notes is sent to a third-party AI service to be analyzed.
        </label>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={run} disabled={disabled} style={buttonStyle}>
          {running ? "Analyzing…" : label}
        </button>
        {shown?.outdated && !running && (
          <span style={{ border: "1px solid currentColor", borderRadius: 4, padding: "2px 8px" }}>Outdated: notes have changed since this run</span>
        )}
      </div>
      {shown && shown.status === "done" && (
        <div style={{ margin: "8px 0" }}>
          <button type="button" aria-pressed={shown.published} onClick={() => void setPublished(!shown.published)} style={buttonStyle}>
            {shown.published ? "Unpublish from participants" : "Publish to participants"}
          </button>
          <p style={mutedStyle}>
            {shown.published ? "Participants can see this analysis." : "Participants cannot see the analysis until you publish it."}
          </p>
        </div>
      )}
      {running && <p role="status" style={mutedStyle}>Analyzing {analysis?.noteCount} notes. This usually takes under a minute.</p>}
      {analysis?.status === "failed" && <p role="alert" style={errorStyle}>The last run failed: {analysis.error ?? "unknown error"}</p>}
      {noNotes && <p style={mutedStyle}>Approve at least one note to run an analysis.</p>}
      {shown && shown.finishedAt && (
        <p style={mutedStyle}>
          Last analyzed {formatTime(shown.finishedAt)} from {shown.noteCount} {shown.noteCount === 1 ? "note" : "notes"}
          {shown.edited ? ", edited by you" : ""}.
        </p>
      )}
      {keywordsOnly && <p style={mutedStyle}>{shown.error ?? "This run produced keywords only."}</p>}
      {error && <p role="alert" style={errorStyle}>{error}</p>}
    </section>
  );
}
