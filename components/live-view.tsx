"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { WORDCLOUD_WORD_MAX } from "@/lib/wordcloud-limits";
import { OpenTextForm } from "@/components/open-text-form";
import { SharedNotesPanel } from "@/components/shared-notes-panel";
import type { LiveInteraction, LivePoll, LiveWordcloud } from "@/lib/live-view";

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

  if (!current) return <p role="status">Waiting for the host…</p>;

  return (
    <section aria-labelledby="live-title">
      <h2 id="live-title">{current.title}</h2>
      {current.type === "sharedNotes" ? (
        <SharedNotesPanel key={current.id} notes={current} socket={socket} />
      ) : current.type === "openText" ? (
        <OpenTextForm key={current.id} question={current} />
      ) : current.state === "closed" ? (
        <p role="status">{current.type === "wordcloud" ? "Submissions closed" : "Voting closed"}</p>
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
      const body = (await res.json().catch(() => ({}))) as { error?: string; counts?: Counts };
      if (res.ok) {
        setVoted(true);
        if (body.counts) setResults({ counts: body.counts.counts, total: body.counts.total });
      } else {
        if (res.status === 409 && body.error === "You have already voted") setVoted(true);
        setError(body.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const locked = voted || submitting;
  const type = poll.multiSelect ? "checkbox" : "radio";
  return (
    <form onSubmit={submit}>
      <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
        <legend style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          {poll.multiSelect ? "Choose one or more options" : "Choose one option"}
        </legend>
        {poll.options.map((o) => (
          <label
            key={o.id}
            style={{ minHeight: 44, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", border: "1px solid #888", borderRadius: 8 }}
          >
            <input
              type={type}
              name="option"
              value={o.id}
              checked={selected.includes(o.id)}
              disabled={locked}
              onChange={() => toggle(o.id)}
            />
            <span>{o.label}</span>
            {results && poll.showResultsToParticipants && (
              <span style={{ marginLeft: "auto" }}>{results.counts[o.id] ?? 0}</span>
            )}
          </label>
        ))}
      </fieldset>
      {!voted && (
        <button type="submit" disabled={submitting || selected.length === 0} style={{ marginTop: 12, minHeight: 44, padding: "0 16px" }}>
          {submitting ? "Submitting…" : "Submit"}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {voted && !error && <p role="status">Thanks, your vote was recorded.</p>}
      {results && poll.showResultsToParticipants && <p>{results.total} {results.total === 1 ? "vote" : "votes"} so far</p>}
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
        setError(body.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      <label style={{ display: "grid", gap: 4 }}>
        Your word
        <input
          value={word}
          onChange={(e) => setWord(e.target.value)}
          maxLength={WORDCLOUD_WORD_MAX}
          disabled={remaining <= 0 || submitting}
          autoComplete="off"
          style={{ minHeight: 44, padding: "0 8px", font: "inherit" }}
        />
      </label>
      <button type="submit" disabled={remaining <= 0 || submitting || !word.trim()} style={{ minHeight: 44, padding: "0 16px" }}>
        {submitting ? "Submitting…" : "Submit"}
      </button>
      <p role="status">
        {remaining > 0
          ? `${remaining} ${remaining === 1 ? "entry" : "entries"} remaining`
          : "You have used all your entries."}
      </p>
      {sent && !error && <p role="status">Thanks, your word was added.</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
