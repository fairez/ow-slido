"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { WORDCLOUD_WORD_MAX } from "@/lib/wordcloud-limits";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError, TextField } from "@/components/ui/field";
import { OpenTextForm } from "@/components/open-text-form";
import { QuizForm } from "@/components/quiz-form";
import { RankingForm } from "@/components/ranking-form";
import { RatingForm } from "@/components/rating-form";
import { SharedNotesPanel } from "@/components/shared-notes-panel";
import type { LiveInteraction, LivePoll, LiveWordcloud } from "@/lib/live-view";
import { useT } from "@/lib/i18n/client";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";

type StateChanged = {
  interactionId: string;
  state: "draft" | "live" | "paused" | "closed";
};

/** Participant's live area: shows the live poll, "Waiting for the host", or "Voting closed". */
export function LiveView({ eventId, initial }: { eventId: string; initial: LiveInteraction | null }) {
  const t = useT();
  const { socket } = useEventSocket(eventId, "participant");
  const [current, setCurrent] = useState<LiveInteraction | null>(initial);
  const currentId = useRef<string | null>(initial?.id ?? null);

  const apply = useCallback((next: LiveInteraction | null) => {
    currentId.current = next?.id ?? null;
    setCurrent(next);
  }, []);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/live`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        interaction: LiveInteraction | null;
      };
      // A closed or paused interaction stays on screen until the host starts another one.
      if (body.interaction === null)
        setCurrent((cur) => (cur?.state === "closed" || cur?.state === "paused" ? cur : null));
      else apply(body.interaction);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [eventId, apply]);

  useEffect(() => {
    if (!socket) return;
    const onChange = (msg: StateChanged) => {
      if ((msg.state === "closed" || msg.state === "paused") && msg.interactionId === currentId.current) {
        const next = msg.state;
        setCurrent((cur) => (cur ? { ...cur, state: next } : cur));
      } else if (msg.state === "live") {
        void refetch();
      }
    };
    // Messages missed while disconnected are not replayed, so resync on every (re)connect.
    const onConnect = () => void refetch();
    socket.on("state-changed", onChange);
    socket.on("connect", onConnect);
    return () => {
      socket.off("state-changed", onChange);
      socket.off("connect", onConnect);
    };
  }, [socket, refetch]);

  if (!current) {
    return (
      <EmptyState title={t("live.waitingTitle")} role="status">
        {t("live.waitingBody")}
      </EmptyState>
    );
  }

  return (
    <section aria-labelledby="live-title" className="live-panel">
      <h2 id="live-title">{current.title}</h2>
      {current.state === "paused" ? (
        <EmptyState title={t("live.pausedTitle")} role="status">
          {t("live.pausedBody")}
        </EmptyState>
      ) : current.type === "sharedNotes" ? (
        <SharedNotesPanel key={current.id} notes={current} socket={socket} />
      ) : current.type === "openText" ? (
        <OpenTextForm key={current.id} question={current} />
      ) : current.type === "rating" ? (
        <RatingForm key={current.id} rating={current} />
      ) : current.type === "ranking" ? (
        <RankingForm key={current.id} ranking={current} />
      ) : current.type === "quiz" ? (
        // A resumed question has a new deadline: a fresh key restarts the countdown.
        <QuizForm key={`${current.id}:${current.deadlineAt}`} quiz={current} />
      ) : current.state === "closed" ? (
        <EmptyState
          title={current.type === "wordcloud" ? t("live.submissionsClosed") : t("live.votingClosed")}
          role="status"
        >
          {t("live.closedBody")}
        </EmptyState>
      ) : current.type === "wordcloud" ? (
        <WordForm key={current.id} cloud={current} />
      ) : (
        <PollForm key={current.id} poll={current} socket={socket} />
      )}
    </section>
  );
}

type Counts = { counts: Record<string, number>; total: number };

function PollForm({ poll, socket }: { poll: LivePoll; socket: ReturnType<typeof useEventSocket>["socket"] }) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [voted, setVoted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Counts | null>(null);

  useEffect(() => {
    if (!socket || !poll.showResultsToParticipants) return;
    const onCounts = (msg: Counts & { interactionId: string }) => {
      if (msg.interactionId === poll.id) setResults({ counts: msg.counts, total: msg.total });
    };
    socket.on("poll:counts", onCounts);
    return () => {
      socket.off("poll:counts", onCounts);
    };
  }, [socket, poll.id, poll.showResultsToParticipants]);

  const toggle = (id: string) =>
    setSelected((cur) => (poll.multiSelect ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (voted || submitting || selected.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/interactions/${poll.id}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionIds: selected }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        counts?: Record<string, number>;
        total?: number;
      };
      if (res.ok) {
        setVoted(true);
        if (body.counts) setResults({ counts: body.counts, total: body.total ?? 0 });
      } else {
        if (res.status === 409 && body.error === "You have already voted") setVoted(true);
        setError(body.error ?? SERVER_ERROR);
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  const locked = voted || submitting;
  const type = poll.multiSelect ? "checkbox" : "radio";
  const showResults = results !== null && poll.showResultsToParticipants;
  const top = showResults ? Math.max(0, ...Object.values(results.counts)) : 0;
  return (
    <form onSubmit={submit} className="live-form">
      <fieldset disabled={locked} className="choice-list">
        <legend className="sr-only">{poll.multiSelect ? t("live.chooseMany") : t("live.chooseOne")}</legend>
        {poll.options.map((o) => {
          const count = showResults ? (results.counts[o.id] ?? 0) : 0;
          const share = showResults && results.total > 0 ? Math.round((count / results.total) * 100) : 0;
          return (
            <label
              key={o.id}
              className="choice"
              data-locked={locked}
              data-leading={showResults && top > 0 && count === top}
            >
              {showResults && <span className="choice-bar" aria-hidden="true" style={{ width: `${share}%` }} />}
              <input
                type={type}
                name="option"
                value={o.id}
                checked={selected.includes(o.id)}
                disabled={locked}
                onChange={() => toggle(o.id)}
              />
              <span className="choice-label">{o.label}</span>
              {showResults && (
                <span className="choice-value">
                  {count} ({share}%)
                </span>
              )}
            </label>
          );
        })}
      </fieldset>
      {!voted && (
        <Button type="submit" variant="primary" busy={submitting} disabled={selected.length === 0}>
          {submitting ? t("live.submitting") : t("live.submit")}
        </Button>
      )}
      {error && <InlineError>{error}</InlineError>}
      {voted && !error && (
        <p role="status" className="confirm">
          {t("live.voted")}
        </p>
      )}
      {showResults && (
        <p className="field-meta">
          {t(results.total === 1 ? "live.votes.one" : "live.votes.other", {
            n: results.total,
          })}
        </p>
      )}
    </form>
  );
}

function WordForm({ cloud }: { cloud: LiveWordcloud }) {
  const t = useT();
  const [word, setWord] = useState("");
  const [remaining, setRemaining] = useState(cloud.remaining);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || remaining <= 0 || !word.trim()) return;
    setSubmitting(true);
    setError(null);
    setSent(false);
    try {
      const res = await fetch(`/api/interactions/${cloud.id}/words`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ word }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        remaining?: number;
      };
      if (res.ok) {
        setRemaining(body.remaining ?? Math.max(0, remaining - 1));
        setWord("");
        setSent(true);
      } else {
        if (res.status === 409 && body.error === "You have used all your entries") setRemaining(0);
        setError(body.error ?? SERVER_ERROR);
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="live-form">
      <TextField
        label={t("live.wordLabel")}
        value={word}
        onChange={(e) => setWord(e.target.value)}
        maxLength={WORDCLOUD_WORD_MAX}
        disabled={remaining <= 0 || submitting}
        autoComplete="off"
      />
      <Button type="submit" variant="primary" busy={submitting} disabled={remaining <= 0 || !word.trim()}>
        {submitting ? t("live.submitting") : t("live.submit")}
      </Button>
      <p role="status" className="field-meta">
        {remaining > 0
          ? t(remaining === 1 ? "live.entries.one" : "live.entries.other", {
              n: remaining,
            })
          : t("live.entriesUsed")}
      </p>
      {sent && !error && (
        <p role="status" className="confirm">
          {t("live.wordAdded")}
        </p>
      )}
      {error && <InlineError>{error}</InlineError>}
    </form>
  );
}
