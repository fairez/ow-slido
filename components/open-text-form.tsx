"use client";

import { useState } from "react";
import { OPEN_TEXT_RESPONSE_MAX } from "@/lib/open-text-limits";
import type { LiveOpenText } from "@/lib/live-view";

/** Participant answer box for an open question: counter, remaining count, confirmation after each send. */
export function OpenTextForm({ question }: { question: LiveOpenText }) {
  const [text, setText] = useState("");
  const [remaining, setRemaining] = useState(question.remaining);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const closed = question.state === "closed";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || remaining <= 0 || !text.trim()) return;
    setSubmitting(true);
    setError(null);
    setSent(false);
    try {
      const res = await fetch(`/api/interactions/${question.id}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setRemaining((n) => Math.max(0, n - 1));
        setText("");
        setSent(true);
      } else {
        if (res.status === 409 && body.error === "You have used all your responses") setRemaining(0);
        setError(body.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (closed) return <p role="status">Responses closed</p>;

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      <label style={{ display: "grid", gap: 4 }}>
        Your response
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={OPEN_TEXT_RESPONSE_MAX}
          rows={4}
          disabled={remaining <= 0 || submitting}
          style={{ padding: 8, font: "inherit", minHeight: 44, resize: "vertical" }}
        />
      </label>
      <p style={{ margin: 0 }} aria-live="off">
        {text.length}/{OPEN_TEXT_RESPONSE_MAX}
      </p>
      <button type="submit" disabled={remaining <= 0 || submitting || !text.trim()} style={{ minHeight: 44, padding: "0 16px" }}>
        {submitting ? "Sending…" : "Send"}
      </button>
      <p role="status">
        {remaining > 0
          ? `${remaining} ${remaining === 1 ? "response" : "responses"} remaining`
          : "You have used all your responses."}
      </p>
      {sent && !error && <p role="status">Thanks, your response was sent.</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
