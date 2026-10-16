"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { NETWORK_ERROR } from "@/lib/copy";

/** Host controls for the event's moderator link: generate/regenerate, copy, revoke. */
export function ModeratorLinkManager({ eventId, initialLink }: { eventId: string; initialLink: string | null }) {
  const [path, setPath] = useState<string | null>(initialLink);
  const [error, setError] = useState<string | null>(null);
  const url = path ? `${window.location.origin}${path}` : null;
  const endpoint = `/api/events/${eventId}/moderator-link`;

  const run = async (method: "POST" | "DELETE") => {
    setError(null);
    try {
      const res = await fetch(endpoint, { method });
      if (!res.ok) return setError("Could not update the moderator link.");
      setPath(method === "POST" ? ((await res.json()) as { link: string }).link : null);
    } catch {
      setError(NETWORK_ERROR);
    }
  };

  return (
    <section aria-labelledby="moderator-link-title" className="moderation">
      <h2 id="moderator-link-title">Moderator link</h2>
      <p className="row-meta">Anyone with this link can moderate questions for this event, and nothing else.</p>
      {error && <InlineError>{error}</InlineError>}
      {url && <input readOnly aria-label="Moderator link" value={url} />}
      <div className="row-actions">
        <Button variant={path ? "secondary" : "primary"} onClick={() => void run("POST")}>
          {path ? "Regenerate link" : "Generate link"}
        </Button>
        {url && <Button onClick={() => void navigator.clipboard?.writeText(url)}>Copy link</Button>}
        {path && (
          <Button variant="quiet" onClick={() => void run("DELETE")}>
            Revoke link
          </Button>
        )}
      </div>
    </section>
  );
}
