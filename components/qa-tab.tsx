"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError, TextArea, TextField } from "@/components/ui/field";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import {
  AUTHOR_NAME_MAX_LENGTH,
  QUESTION_MAX_LENGTH,
  type ParticipantQa,
  type ParticipantQaView,
  type PublicQuestion,
} from "@/lib/question-types";
import { useT } from "@/lib/i18n/client";
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

/** A question's author line: name or "Anonymous", then the pinned and answered marks. */
function Meta({ q }: { q: PublicQuestion }) {
  const t = useT();
  return (
    <span className="post-meta">
      {[q.authorName ?? t("common.anonymous"), q.pinned && t("common.pinned"), q.answered && t("common.answered")]
        .filter(Boolean)
        .join(" · ")}
    </span>
  );
}

const byVotes = (list: PublicQuestion[]) => sortQuestions(list, "popular");

/** An upvote count that cannot be pressed (closed, paused and earlier Q&As). */
function Votes({ n }: { n: number }) {
  const t = useT();
  return (
    <span className="post-meta">
      <span aria-hidden="true">▲</span> <span className="vote-count">{n}</span>
      <span className="sr-only"> {t("qa.votes")}</span>
    </span>
  );
}

/** Closed Q&As from earlier in the event, each folded away with its questions read-only underneath. */
function EarlierQuestions({ earlier }: { earlier: ParticipantQa[] }) {
  const t = useT();
  return (
    <section aria-labelledby="qa-earlier-title" className="qa-earlier">
      <h3 id="qa-earlier-title">{t("qa.earlierTitle")}</h3>
      {earlier.map((qa) => (
        <details key={qa.id} className="qa-earlier-item">
          <summary>
            <span className="qa-earlier-name">{qa.title}</span>
            <span className="post-meta">
              {t(qa.questions.length === 1 ? "qa.earlierCount.one" : "qa.earlierCount.other", { n: qa.questions.length })}
            </span>
          </summary>
          {qa.questions.length === 0 ? (
            <p className="post-meta">{t("qa.earlierEmpty")}</p>
          ) : (
            <ul aria-label={qa.title} className="post-list">
              {byVotes(qa.questions).map((q) => (
                <li key={q.id} className="post" data-pinned={q.pinned}>
                  <p className="post-text">{q.text}</p>
                  <div className="post-foot">
                    <Votes n={q.upvotes} />
                    <Meta q={q} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </details>
      ))}
    </section>
  );
}

/**
 * Participant Q&A: ask a question (optionally with a name) and watch approved questions arrive live. It follows the
 * event's live Q&A; when none is live the latest paused or closed one stays readable, and other closed ones are
 * listed as earlier questions. An event with no Q&A yet still takes a question (the server creates the Q&A).
 */
export function QaTab({ eventId, initial }: { eventId: string; initial: ParticipantQaView }) {
  const t = useT();
  const { socket } = useEventSocket(eventId, "participant");
  const [current, setCurrent] = useState<ParticipantQa | null>(initial.current);
  const [earlier, setEarlier] = useState<ParticipantQa[]>(initial.earlier);
  const [notOpen, setNotOpen] = useState(initial.notOpen === true);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>("recent");
  const currentId = current?.id ?? null;

  const questions = current?.questions ?? [];
  const readOnly = current !== null && current.state !== "live";

  /** Edits the shown Q&A's questions; a message for another Q&A never reaches this. */
  const setQuestions = useCallback((update: (cur: PublicQuestion[]) => PublicQuestion[]) => {
    setCurrent((cur) => (cur ? { ...cur, questions: update(cur.questions) } : cur));
  }, []);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/qa`);
      if (!res.ok) return;
      const body = (await res.json()) as ParticipantQaView;
      setCurrent(body.current);
      setEarlier(body.earlier);
      setNotOpen(body.notOpen === true);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [eventId]);

  useEffect(() => {
    if (!socket) return;
    const mine = (msg: { interactionId?: string }) => msg.interactionId === currentId;
    const onAdded = (msg: { interactionId?: string; question: PublicQuestion }) => {
      if (!mine(msg)) return;
      setQuestions((cur) => (cur.some((q) => q.id === msg.question.id) ? cur : sortQuestions([msg.question, ...cur])));
    };
    const onVotes = (msg: { interactionId?: string; questionId: string; upvotes: number }) => {
      if (!mine(msg)) return;
      setQuestions((cur) => cur.map((q) => (q.id === msg.questionId ? { ...q, upvotes: msg.upvotes } : q)));
    };
    const onUpdated = (msg: { interactionId?: string; questionId: string; pinned: boolean; answered: boolean }) => {
      if (!mine(msg)) return;
      setQuestions((cur) =>
        sortQuestions(
          cur.map((q) => (q.id === msg.questionId ? { ...q, pinned: msg.pinned, answered: msg.answered } : q)),
        ),
      );
    };
    const onRemoved = (msg: { interactionId?: string; questionId: string }) => {
      if (!mine(msg)) return;
      setQuestions((cur) => cur.filter((q) => q.id !== msg.questionId));
    };
    // A start, pause or close can change which Q&A is shown, so ask the server again.
    const onState = () => void refetch();
    // Messages missed while disconnected are not replayed, so resync on every (re)connect.
    const onConnect = () => void refetch();
    socket.on("question:added", onAdded);
    socket.on("question:votes", onVotes);
    socket.on("question:updated", onUpdated);
    socket.on("question:removed", onRemoved);
    socket.on("state-changed", onState);
    socket.on("connect", onConnect);
    return () => {
      socket.off("question:added", onAdded);
      socket.off("question:votes", onVotes);
      socket.off("question:updated", onUpdated);
      socket.off("question:removed", onRemoved);
      socket.off("state-changed", onState);
      socket.off("connect", onConnect);
    };
  }, [socket, refetch, setQuestions, currentId]);

  const toggleUpvote = async (id: string) => {
    if (!current) return;
    try {
      const res = await fetch(`/api/interactions/${current.id}/questions/${id}/upvote`, {
        method: "POST",
      });
      if (!res.ok) {
        setError(res.status === 429 ? t("qa.slowDown") : t("qa.upvoteFailed"));
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
    if (submitting || readOnly || !text.trim()) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const url = current ? `/api/interactions/${current.id}/questions` : `/api/events/${eventId}/questions`;
      const res = await fetch(url, {
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
        if (body.status === "pending") setNotice(t("qa.pending"));
        else {
          setNotice(t("qa.posted"));
          const posted = body.question;
          if (posted)
            setQuestions((cur) => (cur.some((q) => q.id === posted.id) ? cur : sortQuestions([posted, ...cur])));
        }
        // The first question of an event without a Q&A creates one; pick it up.
        if (!current) void refetch();
      } else {
        setError(body.error ?? SERVER_ERROR);
        if (res.status === 409) void refetch();
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  const showCurrentList = questions.length > 0;
  return (
    <section aria-labelledby="qa-title" className="qa-panel">
      <h2 id="qa-title">{current?.title ?? t("qa.title")}</h2>
      {current && current.prompt && <p className="qa-prompt">{current.prompt}</p>}
      {notOpen && !current ? (
        <div className="after-form">
          <EmptyState title={t("qa.notOpenTitle")}>{t("qa.notOpenBody")}</EmptyState>
        </div>
      ) : readOnly && current ? (
        <p role="status" className="waiting">
          {t(current.state === "closed" ? "qa.readOnlyClosed" : "qa.readOnlyPaused")}
        </p>
      ) : (
        <form onSubmit={submit} className="live-form">
          <TextArea
            label={t("qa.questionLabel")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={QUESTION_MAX_LENGTH}
            rows={3}
            disabled={submitting}
            hint={`${text.length}/${QUESTION_MAX_LENGTH}`}
          />
          <TextField
            label={t("common.nameOptional")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={AUTHOR_NAME_MAX_LENGTH}
            autoComplete="off"
            disabled={submitting}
          />
          <Button type="submit" variant="primary" busy={submitting} disabled={!text.trim()}>
            {submitting ? t("common.sending") : t("qa.send")}
          </Button>
          {notice && (
            <p role="status" className="confirm">
              {notice}
            </p>
          )}
          {error && <InlineError>{error}</InlineError>}
        </form>
      )}
      {readOnly && error && <InlineError>{error}</InlineError>}
      {notOpen && !current ? null : !showCurrentList ? (
        <div className="after-form">
          <EmptyState title={t("qa.emptyTitle")}>{readOnly ? null : t("qa.emptyBody")}</EmptyState>
        </div>
      ) : (
        <>
          <div role="group" aria-label={t("qa.sortLabel")} className="sort-bar">
            {(["popular", "recent"] as const).map((mode) => (
              <Button key={mode} aria-pressed={sort === mode} onClick={() => setSort(mode)}>
                {mode === "popular" ? t("common.popular") : t("common.recent")}
              </Button>
            ))}
          </div>
          <ul aria-label={t("qa.listLabel")} className="post-list">
            {sortQuestions(questions, sort).map((q) => (
              <li key={q.id} className="post" data-pinned={q.pinned}>
                <p className="post-text">{q.text}</p>
                <div className="post-foot">
                  {readOnly ? (
                    <Votes n={q.upvotes} />
                  ) : (
                    <Button
                      aria-pressed={q.upvoted}
                      aria-label={t("common.upvote", { text: q.text })}
                      onClick={() => void toggleUpvote(q.id)}
                      variant={q.upvoted ? "primary" : "secondary"}
                    >
                      ▲ <span className="vote-count">{q.upvotes}</span>
                    </Button>
                  )}
                  <Meta q={q} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {earlier.length > 0 && <EarlierQuestions earlier={earlier} />}
    </section>
  );
}
