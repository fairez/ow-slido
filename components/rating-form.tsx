"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError } from "@/components/ui/field";
import { RATING_SCALE_MAX } from "@/lib/rating-limits";
import type { LiveRating } from "@/lib/live-view";
import { useT } from "@/lib/i18n/client";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";

/** Participant rating: a keyboard-operable radio group (arrow keys move the choice) shown as stars or numbers. */
export function RatingForm({ rating }: { rating: LiveRating }) {
  const t = useT();
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
        setError(body.error ?? SERVER_ERROR);
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  if (closed) {
    return (
      <EmptyState title={t("rating.closedTitle")} role="status">
        {selected !== null ? t("rating.gave", { value: selected, max }) : t("rating.closedBody")}
      </EmptyState>
    );
  }

  const locked = done || submitting;
  return (
    <form onSubmit={submit} className="live-form">
      <fieldset className="rating-scale" disabled={locked}>
        <legend>{stars ? t("rating.legendStars") : t("rating.legendNumbers")}</legend>
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
                aria-label={
                  stars
                    ? t(n === 1 ? "rating.star.one" : "rating.star.other", {
                        n,
                      })
                    : String(n)
                }
              />
              <span aria-hidden="true">{stars ? (on ? "★" : "☆") : n}</span>
            </label>
          );
        })}
      </fieldset>
      {!done && (
        <Button type="submit" variant="primary" busy={submitting} disabled={selected === null}>
          {submitting ? t("common.sending") : t("rating.send")}
        </Button>
      )}
      {done && !error && (
        <p role="status" className="confirm">
          {t("rating.thanks", { value: selected ?? "", max })}
        </p>
      )}
      {error && <InlineError>{error}</InlineError>}
    </form>
  );
}
