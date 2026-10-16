"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEventSocket } from "@/lib/realtime/use-event-socket";
import { PresenterNotes } from "@/components/presenter-notes";
import { WordCloud } from "@/components/word-cloud";
import type { PresenterState } from "@/lib/presenter";
import type { PublicNote } from "@/lib/shared-notes";
import type { WordCount } from "@/lib/wordclouds";

export type NavItem = { id: string; state: "draft" | "live" | "closed" };

type Counts = { interactionId: string; counts: Record<string, number>; total: number };
type Words = { interactionId: string; words: WordCount[]; total: number };

/** Full-screen results for the live poll; stays current from `poll:counts` and `state-changed`. */
export function PresenterView({
  eventId,
  initial,
  joinCode,
  items,
}: {
  eventId: string;
  initial: PresenterState | null;
  joinCode: string;
  items: NavItem[];
}) {
  const { socket } = useEventSocket(eventId, "host");
  const [poll, setPoll] = useState<PresenterState | null>(initial);
  const [list, setList] = useState<NavItem[]>(items);
  const [notice, setNotice] = useState("");
  const [qr, setQr] = useState("");
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
      if (e.key === "ArrowRight") void go(1);
      else if (e.key === "ArrowLeft") void go(-1);
      else if (e.key === "Escape" && document.fullscreenElement) void document.exitFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

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
    socket.on("note:added", upsert);
    socket.on("note:updated", upsert);
    socket.on("note:removed", onRemoved);
    socket.on("note:votes", onVotes);
    socket.on("poll:counts", onCounts);
    socket.on("wordcloud:words", onWords);
    socket.on("state-changed", onChange);
    socket.on("connect", onConnect);
    return () => {
      socket.off("note:added", upsert);
      socket.off("note:updated", upsert);
      socket.off("note:removed", onRemoved);
      socket.off("note:votes", onVotes);
      socket.off("poll:counts", onCounts);
      socket.off("wordcloud:words", onWords);
      socket.off("state-changed", onChange);
      socket.off("connect", onConnect);
    };
  }, [socket, refetch, refetchList]);

  const corner = (
    <aside
      aria-label="How to join"
      style={{ position: "fixed", top: 16, right: 16, background: "#fff", color: "#000", padding: 12, textAlign: "center" }}
    >
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt={`QR code to join with code ${joinCode}`} width={140} height={140} />
      )}
      <p style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700 }}>Join code: {joinCode}</p>
    </aside>
  );
  const fullscreenBtn = (
    <button
      type="button"
      onClick={() => void document.documentElement.requestFullscreen?.()}
      style={{ position: "fixed", bottom: 16, right: 16, minHeight: 44, padding: "0 16px", fontSize: "1rem" }}
    >
      Fullscreen (Esc to exit)
    </button>
  );
  const noticeEl = notice && (
    <p role="status" style={{ position: "fixed", bottom: 16, left: 16, fontSize: "1.25rem" }}>
      {notice}
    </p>
  );
  const extras = (
    <>
      {corner}
      {fullscreenBtn}
      {noticeEl}
    </>
  );

  if (!poll) {
    return (
      <>
        {extras}
        <p role="status" style={{ fontSize: "3rem", fontWeight: 700 }}>
          No live interaction
        </p>
      </>
    );
  }

  if (poll.type === "sharedNotes") {
    return (
      <section aria-labelledby="present-title">
        {extras}
        <h1 id="present-title" style={{ fontSize: "3rem", margin: "0 160px 24px 0" }}>
          {poll.title}
        </h1>
        <PresenterNotes notes={poll.notes} closed={poll.state === "closed"} />
      </section>
    );
  }

  if (poll.type === "wordcloud") {
    return (
      <section aria-labelledby="present-title">
        {extras}
        <h1 id="present-title" style={{ fontSize: "3rem", margin: "0 160px 24px 0" }}>
          {poll.title}
        </h1>
        <WordCloud words={poll.words} />
        <p style={{ fontSize: "2rem", marginTop: 24 }}>Total words: {poll.total}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="present-title">
      {extras}
      <h1 id="present-title" style={{ fontSize: "3rem", margin: "0 160px 24px 0" }}>
        {poll.title}
      </h1>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 20 }}>
        {poll.options.map((o) => {
          const count = poll.counts[o.id] ?? 0;
          const percent = poll.total > 0 ? Math.round((count / poll.total) * 100) : 0;
          return (
            <li key={o.id} style={{ fontSize: "2rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, fontWeight: 700 }}>
                <span>{o.label}</span>
                <span>
                  {count} ({percent}%)
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={o.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={`${count} ${count === 1 ? "vote" : "votes"}, ${percent}%`}
                style={{ height: 28, background: "#333", border: "2px solid #fff" }}
              >
                <div style={{ width: `${percent}%`, height: "100%", background: "#ffd400" }} />
              </div>
            </li>
          );
        })}
      </ul>
      <p style={{ fontSize: "2rem", marginTop: 24 }}>Total votes: {poll.total}</p>
    </section>
  );
}
