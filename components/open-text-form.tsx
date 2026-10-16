"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { InlineError, TextArea } from "@/components/ui/field";
import { OPEN_TEXT_RESPONSE_MAX } from "@/lib/open-text-limits";
import type { LiveOpenText } from "@/lib/live-view";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";

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
      <EmptyState title="Responses closed" role="status">
        The host is no longer taking answers.
      </EmptyState>
    );
  }

  return (
    <form onSubmit={submit} className="live-form">
      <TextArea
        label="Your response"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={OPEN_TEXT_RESPONSE_MAX}
        rows={4}
        disabled={remaining <= 0 || submitting}
        hint={`${text.length}/${OPEN_TEXT_RESPONSE_MAX}`}
      />
      <Button type="submit" variant="primary" busy={submitting} disabled={remaining <= 0 || !text.trim()}>
        {submitting ? "Sending" : "Send"}
      </Button>
      <p role="status" className="field-meta">
        {remaining > 0
          ? `${remaining} ${remaining === 1 ? "response" : "responses"} remaining`
          : "You have used all your responses."}
      </p>
      {sent && !error && <p role="status" className="confirm">Thanks, your response was sent.</p>}
      {error && <InlineError>{error}</InlineError>}
    </form>
  );
}
