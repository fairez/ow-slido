"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError } from "@/components/ui/field";
import { RATING_SCALE_MAX } from "@/lib/rating-limits";
import type { LiveRating } from "@/lib/live-view";

/** Participant rating: a keyboard-operable radio group (arrow keys move the choice) shown as stars or numbers. */
export function RatingForm({ rating }: { rating: LiveRating }) {
  const max = RATING_SCALE_MAX[rating.scale];
  const stars = rating.scale === "stars5";
  const [selected, setSelected] = useState<number | null>(rating.mine);
  const [done, setDone] = useState(rating.mine !== null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closed = rating.state === "closed";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || done || selected === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/interactions/${rating.id}/rating`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: selected }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) setDone(true);
      else {
        if (res.status === 409 && body.error === "You have already rated this") setDone(true);
        setError(body.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (closed) {
    return (
      <EmptyState title="Rating closed" role="status">
        {selected !== null ? `You gave ${selected} out of ${max}.` : "The host is no longer taking ratings."}
      </EmptyState>
    );
  }

  const locked = done || submitting;
  return (
    <form onSubmit={submit} className="live-form">
      <fieldset className="rating-scale" disabled={locked}>
        <legend>{stars ? "Your rating, 1 to 5 stars" : "Your rating, 1 to 10"}</legend>
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
          const on = stars ? selected !== null && n <= selected : selected === n;
          return (
            <label key={n} className="rating-choice" data-on={on} data-locked={locked}>
              <input
                type="radio"
                name="rating"
                value={n}
                checked={selected === n}
                onChange={() => setSelected(n)}
                aria-label={stars ? `${n} ${n === 1 ? "star" : "stars"}` : `${n}`}
              />
              <span aria-hidden="true">{stars ? (on ? "★" : "☆") : n}</span>
            </label>
          );
        })}
      </fieldset>
      {!done && (
        <Button type="submit" variant="primary" busy={submitting} disabled={selected === null}>
          {submitting ? "Sending" : "Send rating"}
        </Button>
      )}
      {done && !error && <p role="status" className="confirm">Thanks, you rated this {selected} out of {max}.</p>}
      {error && <InlineError>{error}</InlineError>}
    </form>
  );
}
