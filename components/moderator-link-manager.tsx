"use client";

import { useState } from "react";

/** Host controls for the event's moderator link: generate/regenerate, copy, revoke. */
export function ModeratorLinkManager({ eventId, initialLink }: { eventId: string; initialLink: string | null }) {
  const [path, setPath] = useState<string | null>(initialLink);
  const [error, setError] = useState<string | null>(null);
  const url = path ? `${window.location.origin}${path}` : null;
  const endpoint = `/api/events/${eventId}/moderator-link`;
  const button = { minHeight: 44, padding: "0 12px" };

  const run = async (method: "POST" | "DELETE") => {
    setError(null);
    try {
      const res = await fetch(endpoint, { method });
      if (!res.ok) return setError("Could not update the moderator link.");
      setPath(method === "POST" ? ((await res.json()) as { link: string }).link : null);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
  };

  return (
    <section aria-labelledby="moderator-link-title">
      <h2 id="moderator-link-title">Moderator link</h2>
      <p>Anyone with this link can moderate questions for this event, and nothing else.</p>
      {error && <p role="alert">{error}</p>}
      {url && (
        <p>
          <input readOnly aria-label="Moderator link" value={url} style={{ width: "100%", minHeight: 44 }} />
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={button} onClick={() => void run("POST")}>
          {path ? "Regenerate link" : "Generate link"}
        </button>
        {url && (
          <button type="button" style={button} onClick={() => void navigator.clipboard?.writeText(url)}>
            Copy link
          </button>
        )}
        {path && (
          <button type="button" style={button} onClick={() => void run("DELETE")}>
            Revoke link
          </button>
        )}
      </div>
    </section>
  );
}
