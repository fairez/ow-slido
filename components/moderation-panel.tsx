"use client";

import { useCallback, useEffect, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import type { HostQuestion } from "@/lib/question-types";

type Mode = "open" | "moderated";

const byPinnedThenNewest = (a: HostQuestion, b: HostQuestion) =>
  Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt);

/** Host Q&A controls: the Open/Moderated switch, the pending queue, and approved-question actions. */
export function ModerationPanel({
  eventId,
  initialMode,
  initialQuestions,
}: {
  eventId: string;
  initialMode: Mode;
  initialQuestions: HostQuestion[];
}) {
  const { socket } = useEventSocket(eventId, "host");
  const [mode, setMode] = useState<Mode>(initialMode);
  const [questions, setQuestions] = useState<HostQuestion[]>(initialQuestions);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/moderation`);
      if (!res.ok) return;
      setQuestions(((await res.json()) as { questions: HostQuestion[] }).questions);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [eventId]);

  useEffect(() => {
    if (!socket) return;
    const upsert = (question: HostQuestion) =>
      setQuestions((cur) => [question, ...cur.filter((q) => q.id !== question.id)].sort(byPinnedThenNewest));
    const onPending = (msg: { question: HostQuestion }) => upsert({ ...msg.question, status: "pending" });
    const onAdded = (msg: { question: HostQuestion }) => upsert({ ...msg.question, status: "approved" });
    const onVotes = (msg: { questionId: string; upvotes: number }) =>
      setQuestions((cur) => cur.map((q) => (q.id === msg.questionId ? { ...q, upvotes: msg.upvotes } : q)));
    const onConnect = () => void refetch();
    socket.on("question:pending", onPending);
    socket.on("question:added", onAdded);
    socket.on("question:votes", onVotes);
    socket.on("connect", onConnect);
    return () => {
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
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
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
    const res = await request(`/api/events/${eventId}/questions/${id}`, { method: "DELETE" }, "Could not delete the question.");
    if (res) setQuestions((cur) => cur.filter((q) => q.id !== id));
  };

  const pending = questions.filter((q) => q.status === "pending");
  const approved = questions.filter((q) => q.status === "approved");
  const button = { minHeight: 44, padding: "0 12px" };

  return (
    <section aria-labelledby="moderation-title">
      <h2 id="moderation-title">Q&amp;A moderation</h2>
      <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
        <input
          type="checkbox"
          checked={mode === "moderated"}
          onChange={(e) => void changeMode(e.target.checked ? "moderated" : "open")}
        />
        Moderated Q&amp;A (questions need approval)
      </label>
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
    </section>
  );
}
