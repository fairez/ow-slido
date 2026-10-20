"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError } from "@/components/ui/field";
import type { RankingOption } from "@/lib/interaction-config";
import type { LiveRanking } from "@/lib/live-view";
import { useT } from "@/lib/i18n/client";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";

/** The host's options, rearranged to a submitted order of ids. */
function arrange(options: RankingOption[], order: string[] | null): RankingOption[] {
  if (!order) return options;
  const byId = new Map(options.map((o) => [o.id, o]));
  const placed = order.flatMap((id) => byId.get(id) ?? []);
  return placed.length === options.length ? placed : options;
}

const moveItem = <T,>(list: T[], from: number, to: number): T[] => {
  const next = list.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
};

/**
 * Participant ranking: reorder with a drag handle (pointer events, so touch works) or with up/down buttons,
 * then send the order once. The list is a plain ordered list; position changes go to a polite live region.
 */
export function RankingForm({ ranking }: { ranking: LiveRanking }) {
  const t = useT();
  const [items, setItems] = useState(() => arrange(ranking.options, ranking.mine));
  const [done, setDone] = useState(ranking.mine !== null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);
  const closed = ranking.state === "closed";
  const locked = done || submitting;

  // Moving a focused row in the DOM can drop focus; hand it back to the button that was used.
  useEffect(() => {
    if (!refocus.current) return;
    buttons.current.get(refocus.current)?.focus();
    refocus.current = null;
  }, [items]);

  const place = (id: string, to: number) => {
    const from = items.findIndex((o) => o.id === id);
    if (locked || from < 0 || to < 0 || to >= items.length || to === from) return;
    setItems(moveItem(items, from, to));
    setAnnouncement(t("ranking.moved", { text: items[from].text, position: to + 1, total: items.length }));
  };

  const step = (id: string, delta: -1 | 1) => {
    refocus.current = `${id}:${delta}`;
    place(id, items.findIndex((o) => o.id === id) + delta);
  };

  const startDrag = (e: React.PointerEvent<HTMLElement>, id: string) => {
    if (locked || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    setDragging(id);
  };

  // Window listeners, not pointer capture: React moves the dragged row in the DOM and the browser drops the capture.
  useEffect(() => {
    if (!dragging) return;
    const id = dragging;
    const onMove = (e: PointerEvent) => {
      const from = items.findIndex((o) => o.id === id);
      let to = from;
      items.forEach((o, i) => {
        const box = rows.current.get(o.id)?.getBoundingClientRect();
        if (!box || i === from) return;
        const mid = box.top + box.height / 2;
        if (i < from && e.clientY < mid) to = Math.min(to, i);
        if (i > from && e.clientY > mid) to = Math.max(to, i);
      });
      place(id, to);
    };
    const onEnd = () => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    // `place` closes over `items`, which is in the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, items]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (locked) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/interactions/${ranking.id}/ranking`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order: items.map((o) => o.id) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) setDone(true);
      else {
        // A second device already sent an answer; the server keeps that one.
        if (res.status === 409 && body.error === t("api.alreadyRanked")) setDone(true);
        setError(body.error ?? SERVER_ERROR);
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  if (closed && !done) {
    return (
      <EmptyState title={t("ranking.closedTitle")} role="status">
        {t("ranking.closedBody")}
      </EmptyState>
    );
  }

  return (
    <form onSubmit={submit} className="live-form">
      {ranking.prompt && ranking.prompt !== ranking.title && <p className="ranking-prompt">{ranking.prompt}</p>}
      <p className="field-meta" id={`ranking-hint-${ranking.id}`}>
        {t("ranking.hint")}
      </p>
      <ol className="ranking-list" aria-label={t("ranking.legend")} aria-describedby={`ranking-hint-${ranking.id}`}>
        {items.map((o, i) => (
          <li
            key={o.id}
            ref={(el) => {
              if (el) rows.current.set(o.id, el);
              else rows.current.delete(o.id);
            }}
            className="ranking-item"
            data-dragging={dragging === o.id}
            data-locked={locked}
          >
            <span className="ranking-position" aria-hidden="true">
              {i + 1}
            </span>
            <span className="ranking-text">{o.text}</span>
            {!locked && (
              <>
                <span
                  className="ranking-handle"
                  aria-hidden="true"
                  title={t("ranking.handle", { text: o.text })}
                  onPointerDown={(e) => startDrag(e, o.id)}
                >
                  ⠿
                </span>
                {([-1, 1] as const).map((delta) => {
                  const target = i + delta;
                  const edge = target < 0 || target >= items.length;
                  return (
                    <button
                      key={delta}
                      ref={(el) => {
                        if (el) buttons.current.set(`${o.id}:${delta}`, el);
                        else buttons.current.delete(`${o.id}:${delta}`);
                      }}
                      type="button"
                      className="ranking-step"
                      aria-disabled={edge || undefined}
                      aria-label={t(delta < 0 ? "ranking.moveUp" : "ranking.moveDown", {
                        text: o.text,
                        position: i + 1,
                        total: items.length,
                      })}
                      onClick={() => step(o.id, delta)}
                    >
                      <span aria-hidden="true">{delta < 0 ? "↑" : "↓"}</span>
                    </button>
                  );
                })}
              </>
            )}
          </li>
        ))}
      </ol>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {!done && (
        <Button type="submit" variant="primary" busy={submitting}>
          {submitting ? t("common.sending") : t("ranking.send")}
        </Button>
      )}
      {done && !error && (
        <p role="status" className="confirm">
          {closed ? t("ranking.closedSent") : t("ranking.sent")}
        </p>
      )}
      {error && <InlineError>{error}</InlineError>}
    </form>
  );
}
