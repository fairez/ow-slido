"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InlineError, Select, Toggle } from "@/components/ui/field";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { useCoalesced } from "@/lib/use-coalesced";
import type { HostNote } from "@/lib/note-types";
import type { HostQuestion } from "@/lib/question-types";
import { NETWORK_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";

type Mode = "open" | "moderated";

const byPinnedThenNewest = (a: HostQuestion, b: HostQuestion) =>
  Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt);

const notesByPinnedThenNewest = (a: HostNote, b: HostNote) =>
  Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt);

export type QaOption = { id: string; title: string; state: "draft" | "live" | "paused" | "closed"; moderation: Mode };

/**
 * Host Q&A controls for the selected Q&A: its Open/Moderated switch, the pending queue, and approved-question
 * actions. An event with several Q&As gets a picker; notes stay event-wide.
 */
export function ModerationPanel({
  eventId,
  qas,
  initialQaId,
  initialQuestions,
  initialNotes = [],
  canChangeMode = true,
}: {
  eventId: string;
  qas: QaOption[];
  /** The Q&A whose questions `initialQuestions` holds: the live one, else the first. */
  initialQaId: string | null;
  initialQuestions: HostQuestion[];
  initialNotes?: HostNote[];
  /** False for roles that may moderate but not edit the event: hides the mode switch. */
  canChangeMode?: boolean;
}) {
  const t = useT();
  const { socket } = useEventSocket(eventId, canChangeMode ? "host" : "moderator");
  const [qaList, setQaList] = useState<QaOption[]>(qas);
  const [qaId, setQaId] = useState<string | null>(initialQaId);
  const qa = qaList.find((q) => q.id === qaId) ?? null;
  const mode: Mode = qa?.moderation ?? "open";
  const [questions, setQuestions] = useState<HostQuestion[]>(initialQuestions);
  const [notes, setNotes] = useState<HostNote[]>(initialNotes);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async (forId: string | null = qaId) => {
    try {
      const res = await fetch(`/api/events/${eventId}/moderation${forId ? `?interaction=${forId}` : ""}`);
      if (!res.ok) return;
      const data = (await res.json()) as { questions: HostQuestion[]; notes?: HostNote[] };
      setQuestions(data.questions);
      if (data.notes) setNotes(data.notes);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [eventId, qaId]);

  // Many note events can arrive together; refetch the list once after they settle.
  const refetchSoon = useCoalesced(() => void refetch());

  useEffect(() => {
    if (!socket) return;
    const upsert = (question: HostQuestion) =>
      setQuestions((cur) => [question, ...cur.filter((q) => q.id !== question.id)].sort(byPinnedThenNewest));
    // Messages for the event's other Q&As do not belong in this queue.
    const mine = (msg: { interactionId?: string }) => msg.interactionId === qaId;
    const onPending = (msg: { interactionId?: string; question: HostQuestion }) =>
      mine(msg) && upsert({ ...msg.question, status: "pending" });
    const onAdded = (msg: { interactionId?: string; question: HostQuestion }) =>
      mine(msg) && upsert({ ...msg.question, status: "approved" });
    const onVotes = (msg: { interactionId?: string; questionId: string; upvotes: number }) =>
      mine(msg) &&
      setQuestions((cur) => cur.map((q) => (q.id === msg.questionId ? { ...q, upvotes: msg.upvotes } : q)));
    const onConnect = () => void refetch();
    const onNoteChange = () => refetchSoon();
    const onNoteVotes = (msg: { noteId: string; upvotes: number }) =>
      setNotes((cur) => cur.map((n) => (n.id === msg.noteId ? { ...n, upvotes: msg.upvotes } : n)));
    const onNoteRemoved = (msg: { noteId: string }) => setNotes((cur) => cur.filter((n) => n.id !== msg.noteId));
    socket.on("note:pending", onNoteChange);
    socket.on("note:added", onNoteChange);
    socket.on("note:updated", onNoteChange);
    socket.on("note:votes", onNoteVotes);
    socket.on("note:removed", onNoteRemoved);
    socket.on("question:pending", onPending);
    socket.on("question:added", onAdded);
    socket.on("question:votes", onVotes);
    socket.on("connect", onConnect);
    return () => {
      socket.off("note:pending", onNoteChange);
      socket.off("note:added", onNoteChange);
      socket.off("note:updated", onNoteChange);
      socket.off("note:votes", onNoteVotes);
      socket.off("note:removed", onNoteRemoved);
      socket.off("question:pending", onPending);
      socket.off("question:added", onAdded);
      socket.off("question:votes", onVotes);
      socket.off("connect", onConnect);
    };
  }, [socket, refetch, refetchSoon, qaId]);

  const request = async (url: string, init: RequestInit, failure: string) => {
    setError(null);
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? failure);
    } catch {
      setError(NETWORK_ERROR);
    }
    return null;
  };

  const pickQa = (id: string) => {
    setQaId(id);
    setQuestions([]);
    void refetch(id);
  };

  const changeMode = async (next: Mode) => {
    if (!qaId) return;
    const res = await request(
      `/api/events/${eventId}/interactions/${qaId}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ moderation: next }) },
      t("moderation.modeError"),
    );
    if (res) setQaList((list) => list.map((q) => (q.id === qaId ? { ...q, moderation: next } : q)));
  };

  const change = async (id: string, body: Record<string, unknown>) => {
    const res = await request(
      `/api/interactions/${qaId}/questions/${id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      t("moderation.questionUpdateError"),
    );
    if (!res) return;
    const { question } = (await res.json()) as { question: HostQuestion | null };
    setQuestions((cur) =>
      (question ? cur.map((q) => (q.id === id ? question : q)) : cur.filter((q) => q.id !== id)).sort(
        byPinnedThenNewest,
      ),
    );
  };

  const remove = async (id: string) => {
    const res = await request(`/api/interactions/${qaId}/questions/${id}`, { method: "DELETE" }, t("moderation.questionDeleteError"));
    if (res) setQuestions((cur) => cur.filter((q) => q.id !== id));
  };

  const changeNote = async (id: string, body: Record<string, unknown>) => {
    const res = await request(
      `/api/events/${eventId}/notes/${id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      t("moderation.noteUpdateError"),
    );
    if (!res) return;
    const { note } = (await res.json()) as { note: HostNote | null };
    setNotes((cur) =>
      (note ? cur.map((n) => (n.id === id ? note : n)) : cur.filter((n) => n.id !== id)).sort(notesByPinnedThenNewest),
    );
  };

  const removeNote = async (id: string) => {
    const res = await request(`/api/events/${eventId}/notes/${id}`, { method: "DELETE" }, t("moderation.noteDeleteError"));
    if (res) setNotes((cur) => cur.filter((n) => n.id !== id));
  };

  const pendingNotes = notes.filter((n) => n.status === "pending");
  const approvedNotes = notes.filter((n) => n.status === "approved");
  const pending = questions.filter((q) => q.status === "pending");
  const approved = questions.filter((q) => q.status === "approved");

  return (
    <section aria-labelledby="moderation-title" className="moderation">
      <h2 id="moderation-title">{t("moderation.title")}</h2>
      {qaList.length === 0 && <p className="row-meta">{t("moderation.noQa")}</p>}
      {qaList.length > 1 && (
        <Select label={t("moderation.qaPicker")} value={qaId ?? ""} onChange={(e) => pickQa(e.target.value)}>
          {qaList.map((q) => (
            <option key={q.id} value={q.id}>
              {q.title} ({q.state})
            </option>
          ))}
        </Select>
      )}
      {qa && canChangeMode && <Toggle label={t("moderation.moderatedToggle")} checked={mode === "moderated"} onChange={(e) => void changeMode(e.target.checked ? "moderated" : "open")} />}
      {qa && (
        <p className="row-meta">
          {t("moderation.modeLabel")} <strong>{mode === "moderated" ? t("moderation.modeModerated") : t("moderation.modeOpen")}</strong>
        </p>
      )}
      {qa?.state === "draft" && <p className="row-meta">{t("moderation.draftNote")}</p>}
      {error && <InlineError>{error}</InlineError>}

      <h3>{t("moderation.pendingHeading", { n: pending.length })}</h3>
      {pending.length === 0 ? (
        <p className="row-meta">{t("moderation.noPending")}</p>
      ) : (
        <ul aria-label={t("moderation.pendingList")} className="post-list">
          {pending.map((q) => (
            <li key={q.id} className="post" data-state="pending">
              <p className="post-text">{q.text}</p>
              <p className="post-meta">{q.authorName ?? t("common.anonymous")}</p>
              <div className="post-foot">
                <Button variant="primary" onClick={() => void change(q.id, { status: "approved" })}>
                  {t("moderation.approve")}
                </Button>
                <Button onClick={() => void change(q.id, { status: "rejected" })}>{t("moderation.reject")}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>{t("moderation.approvedHeading", { n: approved.length })}</h3>
      {approved.length === 0 ? (
        <p className="row-meta">{t("moderation.noApproved")}</p>
      ) : (
        <ul aria-label={t("moderation.approvedList")} className="post-list">
          {approved.map((q) => (
            <li key={q.id} className="post" data-pinned={q.pinned} data-answered={q.answered}>
              <p className="post-text">{q.text}</p>
              <p className="post-meta">
                {q.authorName ?? t("common.anonymous")} · ▲ {q.upvotes}
                {q.pinned && <Badge tone="accent">{t("common.pinned")}</Badge>}
                {q.answered && <Badge>{t("common.answered")}</Badge>}
              </p>
              <div className="post-foot">
                <Button onClick={() => void change(q.id, { answered: !q.answered })}>
                  {q.answered ? t("moderation.markUnanswered") : t("moderation.markAnswered")}
                </Button>
                <Button onClick={() => void change(q.id, { pinned: !q.pinned })}>{q.pinned ? t("moderation.unpin") : t("moderation.pin")}</Button>
                <Button variant="quiet" onClick={() => void remove(q.id)}>
                  {t("moderation.delete")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(notes.length > 0 || initialNotes.length > 0) && (
        <>
          <h2>{t("moderation.notesTitle")}</h2>
          <h3>{t("moderation.pendingNotesHeading", { n: pendingNotes.length })}</h3>
          {pendingNotes.length === 0 ? (
            <p className="row-meta">{t("moderation.noPendingNotes")}</p>
          ) : (
            <ul aria-label={t("moderation.pendingNotesList")} className="post-list">
              {pendingNotes.map((n) => (
                <li key={n.id} className="post" data-state="pending">
                  <p className="post-text">{n.text}</p>
                  <p className="post-meta">
                    {n.authorName ?? t("common.anonymous")} · {n.interactionTitle}
                  </p>
                  <div className="post-foot">
                    <Button variant="primary" onClick={() => void changeNote(n.id, { status: "approved" })}>
                      {t("moderation.approveNote")}
                    </Button>
                    <Button onClick={() => void changeNote(n.id, { status: "rejected" })}>{t("moderation.rejectNote")}</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h3>{t("moderation.approvedNotesHeading", { n: approvedNotes.length })}</h3>
          {approvedNotes.length === 0 ? (
            <p className="row-meta">{t("moderation.noApprovedNotes")}</p>
          ) : (
            <ul aria-label={t("moderation.approvedNotesList")} className="post-list">
              {approvedNotes.map((n) => (
                <li key={n.id} className="post" data-pinned={n.pinned}>
                  <p className="post-text">{n.text}</p>
                  <p className="post-meta">
                    {n.authorName ?? t("common.anonymous")} · {n.interactionTitle} · ▲ {n.upvotes}
                    {n.pinned && <Badge tone="accent">{t("common.pinned")}</Badge>}
                  </p>
                  <div className="post-foot">
                    <Button onClick={() => void changeNote(n.id, { pinned: !n.pinned })}>{n.pinned ? t("moderation.unpinNote") : t("moderation.pinNote")}</Button>
                    <Button variant="quiet" onClick={() => void removeNote(n.id)}>
                      {t("moderation.deleteNote")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
