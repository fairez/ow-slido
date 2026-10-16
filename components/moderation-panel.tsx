"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import type { HostNote } from "@/lib/note-types";
import type { HostQuestion } from "@/lib/question-types";

type Mode = "open" | "moderated";

const byPinnedThenNewest = (a: HostQuestion, b: HostQuestion) =>
  Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt);

const notesByPinnedThenNewest = (a: HostNote, b: HostNote) =>
  Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt);

/** Host Q&A controls: the Open/Moderated switch, the pending queue, and approved-question actions. */
export function ModerationPanel({
  eventId,
  initialMode,
  initialQuestions,
  initialNotes = [],
  moderatorToken,
}: {
  eventId: string;
  initialMode: Mode;
  initialQuestions: HostQuestion[];
  initialNotes?: HostNote[];
  /** Set when a moderator (not the host) uses the panel: authenticates calls and hides the mode switch. */
  moderatorToken?: string;
}) {
  const { socket } = useEventSocket(eventId, moderatorToken ? "moderator" : "host", moderatorToken);
  const authHeaders = useMemo<Record<string, string>>(
    () => (moderatorToken ? { "x-moderator-token": moderatorToken } : ({} as Record<string, string>)),
    [moderatorToken],
  );
  const [mode, setMode] = useState<Mode>(initialMode);
  const [questions, setQuestions] = useState<HostQuestion[]>(initialQuestions);
  const [notes, setNotes] = useState<HostNote[]>(initialNotes);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/moderation`, { headers: authHeaders });
      if (!res.ok) return;
      const data = (await res.json()) as { questions: HostQuestion[]; notes?: HostNote[] };
      setQuestions(data.questions);
      if (data.notes) setNotes(data.notes);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [eventId, authHeaders]);

  useEffect(() => {
    if (!socket) return;
    const upsert = (question: HostQuestion) =>
      setQuestions((cur) => [question, ...cur.filter((q) => q.id !== question.id)].sort(byPinnedThenNewest));
    const onPending = (msg: { question: HostQuestion }) => upsert({ ...msg.question, status: "pending" });
    const onAdded = (msg: { question: HostQuestion }) => upsert({ ...msg.question, status: "approved" });
    const onVotes = (msg: { questionId: string; upvotes: number }) =>
      setQuestions((cur) => cur.map((q) => (q.id === msg.questionId ? { ...q, upvotes: msg.upvotes } : q)));
    const onConnect = () => void refetch();
    const onNoteVotes = (msg: { noteId: string; upvotes: number }) =>
      setNotes((cur) => cur.map((n) => (n.id === msg.noteId ? { ...n, upvotes: msg.upvotes } : n)));
    const onNoteRemoved = (msg: { noteId: string }) => setNotes((cur) => cur.filter((n) => n.id !== msg.noteId));
    socket.on("note:pending", onConnect);
    socket.on("note:added", onConnect);
    socket.on("note:updated", onConnect);
    socket.on("note:votes", onNoteVotes);
    socket.on("note:removed", onNoteRemoved);
    socket.on("question:pending", onPending);
    socket.on("question:added", onAdded);
    socket.on("question:votes", onVotes);
    socket.on("connect", onConnect);
    return () => {
      socket.off("note:pending", onConnect);
      socket.off("note:added", onConnect);
      socket.off("note:updated", onConnect);
      socket.off("note:votes", onNoteVotes);
      socket.off("note:removed", onNoteRemoved);
      socket.off("question:pending", onPending);
      socket.off("question:added", onAdded);
      socket.off("question:votes", onVotes);
      socket.off("connect", onConnect);
    };
  }, [socket, refetch]);

  const request = async (url: string, init: RequestInit, failure: string) => {
    setError(null);
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? failure);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
    return null;
  };

  const changeMode = async (next: Mode) => {
    const res = await request(
      `/api/events/${eventId}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ moderationMode: next }) },
      "Could not change the Q&A mode.",
    );
    if (res) setMode(next);
  };

  const change = async (id: string, body: Record<string, unknown>) => {
    const res = await request(
      `/api/events/${eventId}/questions/${id}`,
      { method: "PATCH", headers: { "content-type": "application/json", ...authHeaders }, body: JSON.stringify(body) },
      "Could not update the question.",
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
    const res = await request(`/api/events/${eventId}/questions/${id}`, { method: "DELETE", headers: authHeaders }, "Could not delete the question.");
    if (res) setQuestions((cur) => cur.filter((q) => q.id !== id));
  };

  const changeNote = async (id: string, body: Record<string, unknown>) => {
    const res = await request(
      `/api/events/${eventId}/notes/${id}`,
      { method: "PATCH", headers: { "content-type": "application/json", ...authHeaders }, body: JSON.stringify(body) },
      "Could not update the note.",
    );
    if (!res) return;
    const { note } = (await res.json()) as { note: HostNote | null };
    setNotes((cur) =>
      (note ? cur.map((n) => (n.id === id ? note : n)) : cur.filter((n) => n.id !== id)).sort(notesByPinnedThenNewest),
    );
  };

  const removeNote = async (id: string) => {
    const res = await request(`/api/events/${eventId}/notes/${id}`, { method: "DELETE", headers: authHeaders }, "Could not delete the note.");
    if (res) setNotes((cur) => cur.filter((n) => n.id !== id));
  };

  const pendingNotes = notes.filter((n) => n.status === "pending");
  const approvedNotes = notes.filter((n) => n.status === "approved");
  const pending = questions.filter((q) => q.status === "pending");
  const approved = questions.filter((q) => q.status === "approved");
  const button = { minHeight: 44, padding: "0 12px" };

  return (
    <section aria-labelledby="moderation-title">
      <h2 id="moderation-title">Q&amp;A moderation</h2>
      {!moderatorToken && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
          <input
            type="checkbox"
            checked={mode === "moderated"}
            onChange={(e) => void changeMode(e.target.checked ? "moderated" : "open")}
          />
          Moderated Q&amp;A (questions need approval)
        </label>
      )}
      <p>
        Mode: <strong>{mode === "moderated" ? "Moderated" : "Open"}</strong>
      </p>
      {error && <p role="alert">{error}</p>}

      <h3>Pending ({pending.length})</h3>
      {pending.length === 0 ? (
        <p>No pending questions.</p>
      ) : (
        <ul aria-label="Pending questions" style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
          {pending.map((q) => (
            <li key={q.id} style={{ border: "1px solid #888", borderRadius: 8, padding: 12 }}>
              <p style={{ margin: 0 }}>{q.text}</p>
              <small>{q.authorName ?? "Anonymous"}</small>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" style={button} onClick={() => void change(q.id, { status: "approved" })}>
                  Approve
                </button>
                <button type="button" style={button} onClick={() => void change(q.id, { status: "rejected" })}>
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>Approved ({approved.length})</h3>
      {approved.length === 0 ? (
        <p>No approved questions.</p>
      ) : (
        <ul aria-label="Approved questions" style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
          {approved.map((q) => (
            <li
              key={q.id}
              style={{
                border: "1px solid #888",
                borderRadius: 8,
                padding: 12,
                opacity: q.answered ? 0.7 : 1,
              }}
            >
              <p style={{ margin: 0, textDecoration: q.answered ? "line-through" : "none" }}>{q.text}</p>
              <small>
                {q.authorName ?? "Anonymous"} · ▲ {q.upvotes}
                {q.pinned ? " · Pinned" : ""}
                {q.answered ? " · Answered" : ""}
              </small>
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <button type="button" style={button} onClick={() => void change(q.id, { answered: !q.answered })}>
                  {q.answered ? "Mark unanswered" : "Mark answered"}
                </button>
                <button type="button" style={button} onClick={() => void change(q.id, { pinned: !q.pinned })}>
                  {q.pinned ? "Unpin" : "Pin"}
                </button>
                <button type="button" style={button} onClick={() => void remove(q.id)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(notes.length > 0 || initialNotes.length > 0) && (
        <>
          <h2>Shared notes moderation</h2>
          <h3>Pending notes ({pendingNotes.length})</h3>
          {pendingNotes.length === 0 ? (
            <p>No pending notes.</p>
          ) : (
            <ul aria-label="Pending notes" style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
              {pendingNotes.map((n) => (
                <li key={n.id} style={{ border: "1px solid #888", borderRadius: 8, padding: 12 }}>
                  <p style={{ margin: 0 }}>{n.text}</p>
                  <small>
                    {n.authorName ?? "Anonymous"} · {n.interactionTitle}
                  </small>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button type="button" style={button} onClick={() => void changeNote(n.id, { status: "approved" })}>
                      Approve note
                    </button>
                    <button type="button" style={button} onClick={() => void changeNote(n.id, { status: "rejected" })}>
                      Reject note
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h3>Approved notes ({approvedNotes.length})</h3>
          {approvedNotes.length === 0 ? (
            <p>No approved notes.</p>
          ) : (
            <ul aria-label="Approved notes" style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
              {approvedNotes.map((n) => (
                <li key={n.id} style={{ border: "1px solid #888", borderRadius: 8, padding: 12 }}>
                  <p style={{ margin: 0 }}>{n.text}</p>
                  <small>
                    {n.authorName ?? "Anonymous"} · {n.interactionTitle} · ▲ {n.upvotes}
                    {n.pinned ? " · Pinned" : ""}
                  </small>
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <button type="button" style={button} onClick={() => void changeNote(n.id, { pinned: !n.pinned })}>
                      {n.pinned ? "Unpin note" : "Pin note"}
                    </button>
                    <button type="button" style={button} onClick={() => void removeNote(n.id)}>
                      Delete note
                    </button>
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
