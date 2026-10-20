"use client";

import type { Socket } from "socket.io-client";
import { useCallback, useEffect, useState } from "react";
import { AnalysisEditor } from "@/components/analysis-editor";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/field";
import type { AnalysisEdit } from "@/lib/analysis-edit";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";

type Analysis = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  noteCount: number;
  summary: string | null;
  categories: unknown;
  keywords: unknown;
  edited: boolean;
  published: boolean;
  model: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  outdated: boolean;
};

type State = { analysis: Analysis | null; lastDone: Analysis | null; approvedNoteCount: number; noticeAccepted: boolean; notes: { id: string; text: string }[] };

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Host controls for the AI analysis of one shared-notes interaction. Rendered only when AI is configured. */
export function NotesAnalysisPanel({ interactionId, socket = null }: { interactionId: string; socket?: Socket | null }) {
  const t = useT();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/interactions/${interactionId}/analysis`);
      if (!res.ok) return setError(t("notesAnalysis.loadFailed"));
      setState((await res.json()) as State);
    } catch {
      setError(t("notesAnalysis.loadFailed"));
    }
  }, [interactionId, t]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const running = state?.analysis?.status === "queued" || state?.analysis?.status === "running";

  // The server announces every status change, so no tight polling. A slow poll only covers a missed message.
  useEffect(() => {
    if (!socket) return;
    const onUpdated = (msg: { interactionId: string }) => {
      if (msg.interactionId === interactionId) void load();
    };
    const onConnect = () => void load();
    socket.on("analysis:updated", onUpdated);
    socket.on("connect", onConnect);
    return () => {
      socket.off("analysis:updated", onUpdated);
      socket.off("connect", onConnect);
    };
  }, [socket, interactionId, load]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), socket ? 15_000 : 3000);
    return () => clearInterval(timer);
  }, [running, load, socket]);

  async function run() {
    if (!state) return;
    if (state.lastDone?.edited && !window.confirm(t("notesAnalysis.confirmRerun"))) return;
    setError(null);
    setStarting(true);
    try {
      const res = await fetch(`/api/interactions/${interactionId}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptNotice: accepted }),
      });
      if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? SERVER_ERROR);
      await load();
    } catch {
      setError(NETWORK_ERROR);
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
      if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? SERVER_ERROR);
      await load();
    } catch {
      setError(NETWORK_ERROR);
    }
  }

  async function edit(change: AnalysisEdit): Promise<string | null> {
    try {
      const res = await fetch(`/api/interactions/${interactionId}/analysis`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? SERVER_ERROR;
      await load();
      return null;
    } catch {
      return NETWORK_ERROR;
    }
  }

  if (!state) return error ? <p role="alert" className="analysis-error">{error}</p> : null;

  const { analysis, lastDone, approvedNoteCount, noticeAccepted } = state;
  const needsNotice = !noticeAccepted;
  const noNotes = approvedNoteCount === 0;
  const disabled = running || starting || noNotes || (needsNotice && !accepted);
  const shown = lastDone;
  const keywordsOnly = shown !== null && shown.status === "done" && !shown.summary;
  const label = shown ? t("notesAnalysis.runAgain") : t("notesAnalysis.analyze");

  return (
    <section aria-label={t("notesAnalysis.analyze")} className="analysis">
      <h3>{t("notesAnalysis.title")}</h3>
      <p className="analysis-muted">
        {t(approvedNoteCount === 1 ? "notesAnalysis.approved.one" : "notesAnalysis.approved.other", { n: approvedNoteCount })}
      </p>
      {needsNotice && (
        <Toggle
          label={t("notesAnalysis.notice")}
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
        />
      )}
      <div className="row-actions">
        <Button variant="primary" onClick={run} disabled={disabled} busy={running || starting}>
          {running ? t("notesAnalysis.analyzing") : label}
        </Button>
        {shown?.outdated && !running && (
          <span className="ui-badge" data-tone="accent">{t("notesAnalysis.outdated")}</span>
        )}
      </div>
      {shown && shown.status === "done" && (
        <div className="analysis-part">
          <div className="row-actions">
            <Button aria-pressed={shown.published} onClick={() => void setPublished(!shown.published)}>
              {shown.published ? t("notesAnalysis.unpublish") : t("notesAnalysis.publish")}
            </Button>
          </div>
          <p className="analysis-muted">
            {shown.published ? t("notesAnalysis.visible") : t("notesAnalysis.hidden")}
          </p>
        </div>
      )}
      {running && <p role="status" className="analysis-muted">{t("notesAnalysis.running", { n: analysis?.noteCount ?? "" })}</p>}
      {analysis?.status === "failed" && <p role="alert" className="analysis-error">{t("notesAnalysis.failed", { error: analysis.error ?? t("notesAnalysis.unknownError") })}</p>}
      {noNotes && <p className="analysis-muted">{t("notesAnalysis.needNote")}</p>}
      {shown && shown.finishedAt && (
        <p className="analysis-muted">
          {t(shown.noteCount === 1 ? "notesAnalysis.last.one" : "notesAnalysis.last.other", {
            time: formatTime(shown.finishedAt),
            n: shown.noteCount,
            edited: shown.edited ? t("notesAnalysis.editedByYou") : "",
          })}
        </p>
      )}
      {keywordsOnly && <p className="analysis-muted">{shown.error ?? t("notesAnalysis.keywordsOnly")}</p>}
      {shown && shown.status === "done" && !running && (
        <details>
          <summary>{t("notesAnalysis.review")}</summary>
          <AnalysisEditor
            summary={shown.summary}
            categories={shown.categories}
            keywords={shown.keywords}
            notes={state.notes}
            onEdit={edit}
          />
        </details>
      )}
      {error && <p role="alert" className="analysis-error">{error}</p>}
    </section>
  );
}
