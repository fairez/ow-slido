"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { PresenterOpenText } from "@/components/presenter-open-text";
import { PresenterRating } from "@/components/presenter-rating";
import { PresenterNotes } from "@/components/presenter-notes";
import { PresenterQa } from "@/components/presenter-qa";
import { Button } from "@/components/ui/button";
import { WordCloud } from "@/components/word-cloud";
import type { PresenterState } from "@/lib/presenter";
import { applyQuestionEvent, type QaSort } from "@/lib/question-order";
import type { PublicQuestion } from "@/lib/question-types";
import type { RatingResults } from "@/lib/rating";
import type { PublicResponse } from "@/lib/open-text";
import type { PublicNote } from "@/lib/shared-notes";
import type { WordCount } from "@/lib/wordclouds";

export type NavItem = { id: string; state: "draft" | "live" | "paused" | "closed" };
export type PresenterScreen = "interaction" | "qa";

type Counts = { interactionId: string; counts: Record<string, number>; total: number };
type Words = { interactionId: string; words: WordCount[]; total: number };

/** Full-screen results for the live poll; stays current from `poll:counts` and `state-changed`. */
export function PresenterView({
  eventId,
  initial,
  joinCode,
  items,
  initialQuestions = [],
  initialScreen = "interaction",
}: {
  eventId: string;
  initial: PresenterState | null;
  joinCode: string;
  items: NavItem[];
  initialQuestions?: PublicQuestion[];
  initialScreen?: PresenterScreen;
}) {
  const { socket } = useEventSocket(eventId, "host");
  const [poll, setPoll] = useState<PresenterState | null>(initial);
  const [list, setList] = useState<NavItem[]>(items);
  const [notice, setNotice] = useState("");
  const [qr, setQr] = useState("");
  // Which screen the projector shows. It only changes this page: participants and interaction states are untouched.
  const [screen, setScreen] = useState<PresenterScreen>(initialScreen);
  const [questions, setQuestions] = useState<PublicQuestion[]>(initialQuestions);
  const [qaSort, setQaSort] = useState<QaSort>("popular");
  // Last interaction shown, so arrows still work from the "nothing live" screen.
  const cursor = useRef<string | null>(initial?.id ?? null);
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(`${window.location.origin}/join/${joinCode}`, { margin: 1, width: 200 })
      .then((url) => !cancelled && setQr(url))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [joinCode]);

  const refetchList = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/interactions`);
      if (!res.ok) return;
      const body = (await res.json()) as { interactions: NavItem[] };
      setList(body.interactions.map((i) => ({ id: i.id, state: i.state })));
    } catch {
      // Keep the last known list.
    }
  }, [eventId]);

  const changeScreen = useCallback((next: PresenterScreen) => {
    setScreen(next);
    // Keep the choice in the URL so a reload, or a second tab on another monitor, opens the same screen.
    try {
      const url = new URL(window.location.href);
      if (next === "qa") url.searchParams.set("view", "qa");
      else url.searchParams.delete("view");
      window.history.replaceState(null, "", url);
    } catch {
      // The URL is only a convenience.
    }
  }, []);

  const refetchQuestions = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/present/questions`);
      if (!res.ok) return;
      setQuestions(((await res.json()) as { questions: PublicQuestion[] }).questions);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [eventId]);

  const go = useCallback(
    async (step: 1 | -1) => {
      if (busy.current || list.length === 0) return;
      const liveIdx = list.findIndex((i) => i.state === "live");
      const curIdx = liveIdx >= 0 ? liveIdx : list.findIndex((i) => i.id === cursor.current);
      const next = curIdx < 0 ? (step === 1 ? 0 : list.length - 1) : curIdx + step;
      const target = list[next];
      if (!target) return;
      if (target.state === "live") return;
      if (target.state === "closed") {
        setNotice("That interaction already ran; duplicate it to run it again.");
        return;
      }
      busy.current = true;
      setNotice("");
      try {
        const res = await fetch(`/api/events/${eventId}/interactions/${target.id}/start`, { method: "POST" });
        if (res.ok) cursor.current = target.id;
        else setNotice(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not start");
      } finally {
        busy.current = false;
      }
    },
    [eventId, list],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        // Arrows start the next interaction, so they leave the Q&A screen instead of acting behind it.
        changeScreen("interaction");
        void go(e.key === "ArrowRight" ? 1 : -1);
      } else if (e.key === "q" || e.key === "Q") changeScreen(screen === "qa" ? "interaction" : "qa");
      else if (e.key === "Escape" && document.fullscreenElement) void document.exitFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, changeScreen, screen]);

  const refetch = useCallback(async () => {
    try {
      // Name the notes board on screen so it stays up after the host closes it.
      const closed = cursor.current ? `?closed=${encodeURIComponent(cursor.current)}` : "";
      const res = await fetch(`/api/events/${eventId}/present${closed}`);
      if (!res.ok) return;
      const next = ((await res.json()) as { interaction: PresenterState | null }).interaction;
      if (next) cursor.current = next.id;
      setPoll(next);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [eventId]);

  useEffect(() => {
    if (!socket) return;
    const onCounts = (msg: Counts) =>
      setPoll((cur) =>
        cur && cur.type === "poll" && cur.id === msg.interactionId ? { ...cur, counts: msg.counts, total: msg.total } : cur,
      );
    const onWords = (msg: Words) =>
      setPoll((cur) =>
        cur && cur.type === "wordcloud" && cur.id === msg.interactionId ? { ...cur, words: msg.words, total: msg.total } : cur,
      );
    // Start or close changes which poll is live; the payload has no content, so resync.
    const onChange = () => {
      void refetch();
      void refetchList();
    };
    // Messages missed while disconnected are not replayed.
    const onConnect = () => {
      void refetch();
      void refetchList();
      void refetchQuestions();
    };
    const forNotes = (id: string, fn: (notes: PublicNote[]) => PublicNote[]) =>
      setPoll((cur) => (cur && cur.type === "sharedNotes" && cur.id === id ? { ...cur, notes: fn(cur.notes) } : cur));
    const upsert = (msg: { note: PublicNote | null }) => {
      const note = msg.note;
      if (!note) return;
      forNotes(note.interactionId, (list) =>
        list.some((n) => n.id === note.id) ? list.map((n) => (n.id === note.id ? note : n)) : [...list, note],
      );
    };
    const onRemoved = (msg: { interactionId: string; noteId: string }) =>
      forNotes(msg.interactionId, (list) => list.filter((n) => n.id !== msg.noteId));
    const onVotes = (msg: { interactionId: string; noteId: string; upvotes: number }) =>
      forNotes(msg.interactionId, (list) => list.map((n) => (n.id === msg.noteId ? { ...n, upvotes: msg.upvotes } : n)));
    const forResponses = (id: string, fn: (list: PublicResponse[]) => PublicResponse[]) =>
      setPoll((cur) => (cur && cur.type === "openText" && cur.id === id ? { ...cur, responses: fn(cur.responses) } : cur));
    const onResponse = (msg: { response: PublicResponse }) =>
      forResponses(msg.response.interactionId, (list) =>
        list.some((r) => r.id === msg.response.id)
          ? list.map((r) => (r.id === msg.response.id ? msg.response : r))
          : [...list, msg.response],
      );
    const onResponseRemoved = (msg: { interactionId: string; responseId: string }) =>
      forResponses(msg.interactionId, (list) => list.filter((r) => r.id !== msg.responseId));
    const onRating = (msg: { results: RatingResults }) =>
      setPoll((cur) => (cur && cur.type === "rating" && cur.id === msg.results.interactionId ? { ...cur, results: msg.results } : cur));
    const onQuestion = (name: "question:added" | "question:votes" | "question:updated" | "question:removed") => (msg: object) =>
      setQuestions((cur) => applyQuestionEvent(cur, { name, ...msg } as never));
    const onQuestionAdded = onQuestion("question:added");
    const onQuestionVotes = onQuestion("question:votes");
    const onQuestionUpdated = onQuestion("question:updated");
    const onQuestionRemoved = onQuestion("question:removed");
    socket.on("question:added", onQuestionAdded);
    socket.on("question:votes", onQuestionVotes);
    socket.on("question:updated", onQuestionUpdated);
    socket.on("question:removed", onQuestionRemoved);
    socket.on("rating:results", onRating);
    socket.on("response:added", onResponse);
    socket.on("response:updated", onResponse);
    socket.on("response:removed", onResponseRemoved);
    socket.on("note:added", upsert);
    socket.on("note:updated", upsert);
    socket.on("note:removed", onRemoved);
    socket.on("note:votes", onVotes);
    socket.on("poll:counts", onCounts);
    socket.on("wordcloud:words", onWords);
    socket.on("state-changed", onChange);
    socket.on("connect", onConnect);
    return () => {
      socket.off("question:added", onQuestionAdded);
      socket.off("question:votes", onQuestionVotes);
      socket.off("question:updated", onQuestionUpdated);
      socket.off("question:removed", onQuestionRemoved);
      socket.off("rating:results", onRating);
      socket.off("response:added", onResponse);
      socket.off("response:updated", onResponse);
      socket.off("response:removed", onResponseRemoved);
      socket.off("note:added", upsert);
      socket.off("note:updated", upsert);
      socket.off("note:removed", onRemoved);
      socket.off("note:votes", onVotes);
      socket.off("poll:counts", onCounts);
      socket.off("wordcloud:words", onWords);
      socket.off("state-changed", onChange);
      socket.off("connect", onConnect);
    };
  }, [socket, refetch, refetchList, refetchQuestions]);

  const corner = (
    <aside className="present-join" aria-label="How to join">
      {qr && (
        // Plain img: a data URL needs no optimisation, and the QR keeps a light backing so it scans in dark theme.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="present-qr" src={qr} alt={`QR code to join with code ${joinCode}`} width={140} height={140} />
      )}
      <p className="present-code">Join code: {joinCode}</p>
    </aside>
  );
  const head = (title: string) => (
    <header className="present-head">
      <h1 id="present-title" className="present-title">
        {title}
      </h1>
      {corner}
    </header>
  );
  const extras = (
    <>
      <div className="present-controls">
        <Button aria-keyshortcuts="Q" onClick={() => changeScreen(screen === "qa" ? "interaction" : "qa")}>
          {screen === "qa" ? "Show interaction (Q)" : "Show Q&A (Q)"}
        </Button>
        <Button onClick={() => void document.documentElement.requestFullscreen?.()}>Fullscreen (Esc to exit)</Button>
      </div>
      {notice && (
        <p role="status" className="present-notice">
          {notice}
        </p>
      )}
    </>
  );

  if (screen === "qa") {
    return (
      <section aria-labelledby="present-title">
        {head("Q&A")}
        <PresenterQa questions={questions} sort={qaSort} onSortChange={setQaSort} joinCode={joinCode} />
        {extras}
      </section>
    );
  }

  if (!poll) {
    return (
      <>
        <header className="present-head">
          <h1 aria-live="polite" className="present-title">
            No live interaction
          </h1>
          {corner}
        </header>
        {extras}
      </>
    );
  }

  if (poll.type === "sharedNotes") {
    return (
      <section aria-labelledby="present-title">
        {head(poll.title)}
        <PresenterNotes interactionId={poll.id} notes={poll.notes} closed={poll.state === "closed"} socket={socket} />
        {extras}
      </section>
    );
  }

  if (poll.type === "rating") {
    return (
      <section aria-labelledby="present-title">
        {head(poll.title)}
        <PresenterRating results={poll.results} closed={poll.state === "closed"} />
        {extras}
      </section>
    );
  }

  if (poll.type === "openText") {
    return (
      <section aria-labelledby="present-title">
        {head(poll.title)}
        <PresenterOpenText responses={poll.responses} closed={poll.state === "closed"} />
        {extras}
      </section>
    );
  }

  if (poll.type === "wordcloud") {
    return (
      <section aria-labelledby="present-title">
        {head(poll.title)}
        <WordCloud words={poll.words} />
        <p className="present-total">Total words: {poll.total}</p>
        {extras}
      </section>
    );
  }

  const lead = Math.max(0, ...Object.values(poll.counts));
  return (
    <section aria-labelledby="present-title">
      {head(poll.title)}
      <ul className="present-bars">
        {poll.options.map((o) => {
          const count = poll.counts[o.id] ?? 0;
          const percent = poll.total > 0 ? Math.round((count / poll.total) * 100) : 0;
          return (
            <li key={o.id}>
              <div className="present-bar-head">
                <span>{o.label}</span>
                <span>
                  {count} ({percent}%)
                </span>
              </div>
              <div
                className="present-track"
                role="progressbar"
                aria-label={o.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={`${count} ${count === 1 ? "vote" : "votes"}, ${percent}%`}
              >
                <div className="present-fill" data-leading={count > 0 && count === lead} style={{ width: `${percent}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="present-total">Total votes: {poll.total}</p>
      {extras}
    </section>
  );
}
