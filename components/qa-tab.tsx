"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError, TextArea, TextField } from "@/components/ui/field";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { AUTHOR_NAME_MAX_LENGTH, QUESTION_MAX_LENGTH, type PublicQuestion } from "@/lib/question-types";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";

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
    const onUpdated = (msg: { questionId: string; pinned: boolean; answered: boolean }) =>
      setQuestions((cur) =>
        sortQuestions(
          cur.map((q) => (q.id === msg.questionId ? { ...q, pinned: msg.pinned, answered: msg.answered } : q)),
        ),
      );
    const onRemoved = (msg: { questionId: string }) =>
      setQuestions((cur) => cur.filter((q) => q.id !== msg.questionId));
    // Messages missed while disconnected are not replayed, so resync on every (re)connect.
    const onConnect = () => void refetch();
    socket.on("question:added", onAdded);
    socket.on("question:votes", onVotes);
    socket.on("question:updated", onUpdated);
    socket.on("question:removed", onRemoved);
    socket.on("connect", onConnect);
    return () => {
      socket.off("question:added", onAdded);
      socket.off("question:votes", onVotes);
      socket.off("question:updated", onUpdated);
      socket.off("question:removed", onRemoved);
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
      setError(NETWORK_ERROR);
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
        setError(body.error ?? SERVER_ERROR);
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="qa-title" className="qa-panel">
      <h2 id="qa-title">Questions</h2>
      <form onSubmit={submit} className="live-form">
        <TextArea
          label="Your question"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={QUESTION_MAX_LENGTH}
          rows={3}
          disabled={submitting}
          hint={`${text.length}/${QUESTION_MAX_LENGTH}`}
        />
        <TextField
          label="Your name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={AUTHOR_NAME_MAX_LENGTH}
          autoComplete="off"
          disabled={submitting}
        />
        <Button type="submit" variant="primary" busy={submitting} disabled={!text.trim()}>
          {submitting ? "Sending" : "Send question"}
        </Button>
        {notice && <p role="status" className="confirm">{notice}</p>}
        {error && <InlineError>{error}</InlineError>}
      </form>
      {questions.length === 0 ? (
        <div className="after-form">
          <EmptyState title="No questions yet">Be the first to ask.</EmptyState>
        </div>
      ) : (
        <>
          <div role="group" aria-label="Sort questions" className="sort-bar">
            {(["popular", "recent"] as const).map((mode) => (
              <Button key={mode} aria-pressed={sort === mode} onClick={() => setSort(mode)}>
                {mode === "popular" ? "Popular" : "Recent"}
              </Button>
            ))}
          </div>
          <ul aria-label="Approved questions" className="post-list">
            {sortQuestions(questions, sort).map((q) => (
              <li key={q.id} className="post" data-pinned={q.pinned}>
                <p className="post-text">{q.text}</p>
                <div className="post-foot">
                  <Button
                    aria-pressed={q.upvoted}
                    aria-label={`Upvote: ${q.text}`}
                    onClick={() => void toggleUpvote(q.id)}
                    variant={q.upvoted ? "primary" : "secondary"}
                  >
                    ▲ <span className="vote-count">{q.upvotes}</span>
                  </Button>
                  <span className="post-meta">
                    {q.authorName ?? "Anonymous"}
                    {q.pinned ? " · Pinned" : ""}
                    {q.answered ? " · Answered" : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
