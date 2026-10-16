"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { LiveNotes } from "@/lib/live-view";
import type { ParticipantNote } from "@/lib/shared-notes";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError, TextArea, TextField } from "@/components/ui/field";
import { PublishedAnalysis } from "@/components/published-analysis";
import { NOTE_TEXT_MAX } from "@/lib/note-limits";
import { AUTHOR_NAME_MAX_LENGTH } from "@/lib/question-types";

type SortMode = "popular" | "recent";

/** Pinned notes stay on top in both modes; Popular breaks ties by newest. */
const sortNotes = (list: ParticipantNote[], mode: SortMode) =>
  [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (mode === "popular" ? b.upvotes - a.upvotes : 0) ||
      b.createdAt.localeCompare(a.createdAt),
  );

const NETWORK_ERROR = "Could not reach the server. Check your connection and try again.";

type Props = { notes: LiveNotes; socket: Socket | null };

/** Participant side of a shared notes interaction: write notes, upvote others' notes, edit or delete your own. */
export function SharedNotesPanel({ notes: config, socket }: Props) {
  const closed = config.state === "closed";
  const [list, setList] = useState<ParticipantNote[]>([]);
  const [sort, setSort] = useState<SortMode>("popular");
  const [remaining, setRemaining] = useState(config.remaining);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const ownIds = useRef(new Set<string>());

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/interactions/${config.id}/notes?sort=recent`);
      if (!res.ok) return;
      const body = (await res.json()) as { notes: ParticipantNote[] };
      body.notes.forEach((n) => n.mine && ownIds.current.add(n.id));
      setList(body.notes);
    } catch {
      // Offline: the next reconnect refetches.
    }
  }, [config.id]);

  useEffect(() => {
    // Initial load, deferred so the effect body doesn't set state synchronously; the socket's connect event covers resyncs.
    queueMicrotask(() => void refetch());
  }, [refetch]);

  useEffect(() => {
    if (!socket) return;
    const mine = (interactionId: string) => interactionId === config.id;
    const onAdded = (msg: { note: ParticipantNote | null }) => {
      const n = msg.note;
      if (!n || !mine(n.interactionId)) return;
      setList((cur) =>
        cur.some((x) => x.id === n.id) ? cur : [{ ...n, mine: ownIds.current.has(n.id), iUpvoted: false }, ...cur],
      );
    };
    const onUpdated = (msg: { note: ParticipantNote | null }) => {
      const n = msg.note;
      if (!n || !mine(n.interactionId)) return;
      setList((cur) =>
        cur.some((x) => x.id === n.id)
          ? cur.map((x) => (x.id === n.id ? { ...x, text: n.text, authorName: n.authorName, pinned: n.pinned, upvotes: n.upvotes } : x))
          : [{ ...n, mine: ownIds.current.has(n.id), iUpvoted: false }, ...cur],
      );
    };
    const onRemoved = (msg: { interactionId: string; noteId: string }) => {
      if (mine(msg.interactionId)) setList((cur) => cur.filter((x) => x.id !== msg.noteId));
    };
    const onVotes = (msg: { interactionId: string; noteId: string; upvotes: number }) => {
      if (mine(msg.interactionId)) {
        setList((cur) => cur.map((x) => (x.id === msg.noteId ? { ...x, upvotes: msg.upvotes } : x)));
      }
    };
    const onConnect = () => void refetch();
    socket.on("note:added", onAdded);
    socket.on("note:updated", onUpdated);
    socket.on("note:removed", onRemoved);
    socket.on("note:votes", onVotes);
    socket.on("connect", onConnect);
    return () => {
      socket.off("note:added", onAdded);
      socket.off("note:updated", onUpdated);
      socket.off("note:removed", onRemoved);
      socket.off("note:votes", onVotes);
      socket.off("connect", onConnect);
    };
  }, [socket, config.id, refetch]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || remaining <= 0 || !text.trim()) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/interactions/${config.id}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, authorName: config.showAuthorNames ? name.trim() || undefined : undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        note?: { id: string; text: string; authorName: string | null; status: string; pinned: boolean; createdAt: string };
      };
      if (res.ok && body.note) {
        const n = body.note;
        setText("");
        setRemaining((r) => Math.max(0, r - 1));
        if (n.status === "pending") {
          setNotice("Your note is waiting for approval. It will appear here once the host approves it.");
        } else {
          ownIds.current.add(n.id);
          setNotice("Your note was posted.");
          const posted: ParticipantNote = {
            id: n.id,
            interactionId: config.id,
            text: n.text,
            authorName: n.authorName,
            pinned: n.pinned,
            createdAt: n.createdAt,
            upvotes: 0,
            mine: true,
            iUpvoted: false,
          };
          setList((cur) =>
            cur.some((x) => x.id === n.id) ? cur.map((x) => (x.id === n.id ? { ...x, mine: true } : x)) : [posted, ...cur],
          );
        }
      } else {
        if (res.status === 409 && body.error === "You have used all your notes") setRemaining(0);
        setError(res.status === 429 ? "Slow down a little, then try again." : (body.error ?? "Something went wrong. Please try again."));
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleUpvote = async (id: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/notes/${id}/upvote`, { method: "POST" });
      if (!res.ok) {
        setError(res.status === 429 ? "Slow down a little, then try again." : "Could not record your upvote.");
        return;
      }
      const body = (await res.json()) as { upvoted: boolean; upvotes: number };
      setList((cur) => cur.map((x) => (x.id === id ? { ...x, iUpvoted: body.upvoted, upvotes: body.upvotes } : x)));
    } catch {
      setError(NETWORK_ERROR);
    }
  };

  const saveEdit = async (id: string) => {
    if (busyId || !draft.trim()) return;
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/notes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: draft }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; note?: { text: string; status: string } };
      if (res.ok && body.note) {
        const edited = body.note;
        setEditingId(null);
        if (edited.status === "pending") {
          setList((cur) => cur.filter((x) => x.id !== id));
          setNotice("Your edit is waiting for approval. The note is hidden until the host approves it.");
        } else {
          setList((cur) => cur.map((x) => (x.id === id ? { ...x, text: edited.text } : x)));
        }
      } else {
        setError(body.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/notes/${id}`, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        ownIds.current.delete(id);
        setList((cur) => cur.filter((x) => x.id !== id));
        if (res.ok) setRemaining((r) => Math.min(config.maxNotes, r + 1));
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusyId(null);
    }
  };

  const remainingText =
    remaining > 0 ? `${remaining} ${remaining === 1 ? "note" : "notes"} remaining` : "You have used all your notes.";

  return (
    <div className="live-form">
      <PublishedAnalysis interactionId={config.id} socket={socket} />
      {config.aiDisclosure && (
        <p className="field-meta">
          The host may have an AI service summarise these notes. Your name is never sent.
        </p>
      )}
      {closed ? (
        <EmptyState title="Notes are closed" role="status">
          You can still upvote.
        </EmptyState>
      ) : (
        <form onSubmit={submit} className="live-form">
          <TextArea
            label="Your note"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={NOTE_TEXT_MAX}
            rows={4}
            disabled={remaining <= 0 || submitting}
            hint={`${text.length}/${NOTE_TEXT_MAX}`}
          />
          {config.showAuthorNames && (
            <TextField
              label="Your name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={AUTHOR_NAME_MAX_LENGTH}
              autoComplete="off"
              disabled={remaining <= 0 || submitting}
            />
          )}
          <Button type="submit" variant="primary" busy={submitting} disabled={remaining <= 0 || !text.trim()}>
            {submitting ? "Sending" : "Send note"}
          </Button>
          <p role="status" className="field-meta">{remainingText}</p>
        </form>
      )}
      {notice && <p role="status" className="confirm">{notice}</p>}
      {error && <InlineError>{error}</InlineError>}
      {list.length === 0 ? (
        <EmptyState title="No notes yet">Notes appear here as people post them.</EmptyState>
      ) : (
        <div>
          <div role="group" aria-label="Sort notes" className="sort-bar">
            {(["popular", "recent"] as const).map((mode) => (
              <Button key={mode} aria-pressed={sort === mode} onClick={() => setSort(mode)}>
                {mode === "popular" ? "Popular" : "Recent"}
              </Button>
            ))}
          </div>
          <ul aria-label="Notes" className="post-list">
            {sortNotes(list, sort).map((n) => (
              <li key={n.id} className="post" data-pinned={n.pinned}>
                {editingId === n.id ? (
                  <div className="live-form">
                    <TextArea
                      label="Edit your note"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      maxLength={NOTE_TEXT_MAX}
                      rows={4}
                      disabled={busyId === n.id}
                      hint={`${draft.length}/${NOTE_TEXT_MAX}`}
                    />
                    <div className="post-foot">
                      <Button variant="primary" disabled={busyId === n.id || !draft.trim()} onClick={() => void saveEdit(n.id)}>
                        Save
                      </Button>
                      <Button disabled={busyId === n.id} onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="post-text">{n.text}</p>
                    <div className="post-foot">
                      {n.mine ? (
                        !closed && (
                          <>
                            <Button
                              aria-label={`Edit your note: ${n.text}`}
                              disabled={busyId === n.id}
                              onClick={() => {
                                setEditingId(n.id);
                                setDraft(n.text);
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              aria-label={`Delete your note: ${n.text}`}
                              disabled={busyId === n.id}
                              onClick={() => void remove(n.id)}
                            >
                              Delete
                            </Button>
                          </>
                        )
                      ) : (
                        <Button
                          aria-pressed={n.iUpvoted}
                          aria-label={`Upvote: ${n.text}`}
                          onClick={() => void toggleUpvote(n.id)}
                          variant={n.iUpvoted ? "primary" : "secondary"}
                        >
                          ▲ <span className="vote-count">{n.upvotes}</span>
                        </Button>
                      )}
                      {n.mine && <span className="vote-count">▲ {n.upvotes}</span>}
                      <span className="post-meta">
                        {n.authorName ?? "Anonymous"}
                        {n.pinned ? " · Pinned" : ""}
                        {n.mine ? " · You" : ""}
                      </span>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
