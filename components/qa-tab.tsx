"use client";

import { useCallback, useEffect, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { AUTHOR_NAME_MAX_LENGTH, QUESTION_MAX_LENGTH, type PublicQuestion } from "@/lib/question-types";

const sortQuestions = (list: PublicQuestion[]) =>
  [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));

/** Participant Q&A: ask a question (optionally with a name) and watch approved questions arrive live. */
export function QaTab({ eventId, initial }: { eventId: string; initial: PublicQuestion[] }) {
  const { socket } = useEventSocket(eventId, "participant");
  const [questions, setQuestions] = useState<PublicQuestion[]>(initial);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/questions`);
      if (!res.ok) return;
      const body = (await res.json()) as { questions: PublicQuestion[] };
      setQuestions(body.questions);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [eventId]);

  useEffect(() => {
    if (!socket) return;
    const onAdded = (msg: { question: PublicQuestion }) =>
      setQuestions((cur) => (cur.some((q) => q.id === msg.question.id) ? cur : sortQuestions([msg.question, ...cur])));
    // Messages missed while disconnected are not replayed, so resync on every (re)connect.
    const onConnect = () => void refetch();
    socket.on("question:added", onAdded);
    socket.on("connect", onConnect);
    return () => {
      socket.off("question:added", onAdded);
      socket.off("connect", onConnect);
    };
  }, [socket, refetch]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !text.trim()) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/events/${eventId}/questions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, authorName: name.trim() || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: "pending" | "approved";
        question?: PublicQuestion;
      };
      if (res.ok) {
        setText("");
        if (body.status === "pending") setNotice("Your question is waiting for approval");
        else {
          setNotice("Thanks, your question was posted.");
          const posted = body.question;
          if (posted) setQuestions((cur) => (cur.some((q) => q.id === posted.id) ? cur : sortQuestions([posted, ...cur])));
        }
      } else {
        setError(body.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="qa-title">
      <h2 id="qa-title">Questions</h2>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          Your question
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={QUESTION_MAX_LENGTH}
            rows={3}
            disabled={submitting}
            style={{ padding: 8, font: "inherit" }}
          />
        </label>
        <span>
          {text.length}/{QUESTION_MAX_LENGTH}
        </span>
        <label style={{ display: "grid", gap: 4 }}>
          Your name (optional)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={AUTHOR_NAME_MAX_LENGTH}
            autoComplete="off"
            disabled={submitting}
            style={{ minHeight: 44, padding: "0 8px", font: "inherit" }}
          />
        </label>
        <button type="submit" disabled={submitting || !text.trim()} style={{ minHeight: 44, padding: "0 16px" }}>
          {submitting ? "Sending…" : "Send question"}
        </button>
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
      </form>
      {questions.length === 0 ? (
        <p>No questions yet.</p>
      ) : (
        <ul aria-label="Approved questions" style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
          {questions.map((q) => (
            <li key={q.id} style={{ border: "1px solid #888", borderRadius: 8, padding: 12 }}>
              <p style={{ margin: 0 }}>{q.text}</p>
              <small>
                {q.authorName ?? "Anonymous"}
                {q.pinned ? " · Pinned" : ""}
                {q.answered ? " · Answered" : ""}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
