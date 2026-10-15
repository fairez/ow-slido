"use client";

import { useCallback, useEffect, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { AUTHOR_NAME_MAX_LENGTH, QUESTION_MAX_LENGTH, type PublicQuestion } from "@/lib/question-types";

type SortMode = "popular" | "recent";

/** Pinned questions stay on top in both modes; Popular breaks ties by newest. */
const sortQuestions = (list: PublicQuestion[], mode: SortMode = "recent") =>
  [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (mode === "popular" ? b.upvotes - a.upvotes : 0) ||
      b.createdAt.localeCompare(a.createdAt),
  );

/** Participant Q&A: ask a question (optionally with a name) and watch approved questions arrive live. */
export function QaTab({ eventId, initial }: { eventId: string; initial: PublicQuestion[] }) {
  const { socket } = useEventSocket(eventId, "participant");
  const [questions, setQuestions] = useState<PublicQuestion[]>(initial);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>("recent");

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
    const onVotes = (msg: { questionId: string; upvotes: number }) =>
      setQuestions((cur) => cur.map((q) => (q.id === msg.questionId ? { ...q, upvotes: msg.upvotes } : q)));
    // Messages missed while disconnected are not replayed, so resync on every (re)connect.
    const onConnect = () => void refetch();
    socket.on("question:added", onAdded);
    socket.on("question:votes", onVotes);
    socket.on("connect", onConnect);
    return () => {
      socket.off("question:added", onAdded);
      socket.off("question:votes", onVotes);
      socket.off("connect", onConnect);
    };
  }, [socket, refetch]);

  const toggleUpvote = async (id: string) => {
    try {
      const res = await fetch(`/api/questions/${id}/upvote`, {
        method: "POST",
      });
      if (!res.ok) {
        setError(res.status === 429 ? "Slow down a little, then try again." : "Could not record your upvote.");
        return;
      }
      const body = (await res.json()) as { upvoted: boolean; upvotes: number };
      setQuestions((cur) => cur.map((q) => (q.id === id ? { ...q, upvoted: body.upvoted, upvotes: body.upvotes } : q)));
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
  };

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
          if (posted)
            setQuestions((cur) => (cur.some((q) => q.id === posted.id) ? cur : sortQuestions([posted, ...cur])));
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
        <>
          <div role="group" aria-label="Sort questions" style={{ display: "flex", gap: 8, margin: "16px 0 8px" }}>
            {(["popular", "recent"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={sort === mode}
                onClick={() => setSort(mode)}
                style={{
                  minHeight: 44,
                  padding: "0 16px",
                  fontWeight: sort === mode ? 700 : 400,
                }}
              >
                {mode === "popular" ? "Popular" : "Recent"}
              </button>
            ))}
          </div>
          <ul aria-label="Approved questions" style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
            {sortQuestions(questions, sort).map((q) => (
              <li
                key={q.id}
                style={{
                  border: "1px solid #888",
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <p style={{ margin: 0 }}>{q.text}</p>
                <button
                  type="button"
                  aria-pressed={q.upvoted}
                  aria-label={`Upvote: ${q.text}`}
                  onClick={() => void toggleUpvote(q.id)}
                  style={{
                    minHeight: 44,
                    minWidth: 44,
                    padding: "0 12px",
                    fontWeight: q.upvoted ? 700 : 400,
                  }}
                >
                  ▲ {q.upvotes}
                </button>{" "}
                <small>
                  {q.authorName ?? "Anonymous"}
                  {q.pinned ? " · Pinned" : ""}
                  {q.answered ? " · Answered" : ""}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
