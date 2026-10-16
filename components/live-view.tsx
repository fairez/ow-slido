"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { WORDCLOUD_WORD_MAX } from "@/lib/wordcloud-limits";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError, TextField } from "@/components/ui/field";
import { OpenTextForm } from "@/components/open-text-form";
import { RatingForm } from "@/components/rating-form";
import { SharedNotesPanel } from "@/components/shared-notes-panel";
import type { LiveInteraction, LivePoll, LiveWordcloud } from "@/lib/live-view";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";

type StateChanged = { interactionId: string; state: "draft" | "live" | "closed" };

/** Participant's live area: shows the live poll, "Waiting for the host", or "Voting closed". */
export function LiveView({ eventId, initial }: { eventId: string; initial: LiveInteraction | null }) {
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
      const body = (await res.json()) as { interaction: LiveInteraction | null };
      // A closed poll stays on screen as "Voting closed" until the host starts another one.
      if (body.interaction === null) setCurrent((cur) => (cur?.state === "closed" ? cur : null));
      else apply(body.interaction);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [eventId, apply]);

  useEffect(() => {
    if (!socket) return;
    const onChange = (msg: StateChanged) => {
      if (msg.state === "closed" && msg.interactionId === currentId.current) {
        setCurrent((cur) => (cur ? { ...cur, state: "closed" } : cur));
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
      <EmptyState title="Waiting for the host" role="status">
        The next question will appear here as soon as it starts.
      </EmptyState>
    );
  }

  return (
    <section aria-labelledby="live-title" className="live-panel">
      <h2 id="live-title">{current.title}</h2>
      {current.type === "sharedNotes" ? (
        <SharedNotesPanel key={current.id} notes={current} socket={socket} />
      ) : current.type === "openText" ? (
        <OpenTextForm key={current.id} question={current} />
      ) : current.type === "rating" ? (
        <RatingForm key={current.id} rating={current} />
      ) : current.state === "closed" ? (
        <EmptyState title={current.type === "wordcloud" ? "Submissions closed" : "Voting closed"} role="status">
          The host has closed this one. Stay here for the next.
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
    setSelected((cur) =>
      poll.multiSelect ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id],
    );

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
      const body = (await res.json().catch(() => ({}))) as { error?: string; counts?: Record<string, number>; total?: number };
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
        <legend className="sr-only">{poll.multiSelect ? "Choose one or more options" : "Choose one option"}</legend>
        {poll.options.map((o) => {
          const count = showResults ? (results.counts[o.id] ?? 0) : 0;
          const share = showResults && results.total > 0 ? Math.round((count / results.total) * 100) : 0;
          return (
            <label key={o.id} className="choice" data-locked={locked} data-leading={showResults && top > 0 && count === top}>
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
          {submitting ? "Submitting" : "Submit"}
        </Button>
      )}
      {error && <InlineError>{error}</InlineError>}
      {voted && !error && <p role="status" className="confirm">Thanks, your vote was recorded.</p>}
      {showResults && <p className="field-meta">{results.total} {results.total === 1 ? "vote" : "votes"} so far</p>}
    </form>
  );
}

function WordForm({ cloud }: { cloud: LiveWordcloud }) {
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
      const body = (await res.json().catch(() => ({}))) as { error?: string; remaining?: number };
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
        label="Your word"
        value={word}
        onChange={(e) => setWord(e.target.value)}
        maxLength={WORDCLOUD_WORD_MAX}
        disabled={remaining <= 0 || submitting}
        autoComplete="off"
      />
      <Button type="submit" variant="primary" busy={submitting} disabled={remaining <= 0 || !word.trim()}>
        {submitting ? "Submitting" : "Submit"}
      </Button>
      <p role="status" className="field-meta">
        {remaining > 0
          ? `${remaining} ${remaining === 1 ? "entry" : "entries"} remaining`
          : "You have used all your entries."}
      </p>
      {sent && !error && <p role="status" className="confirm">Thanks, your word was added.</p>}
      {error && <InlineError>{error}</InlineError>}
    </form>
  );
}
