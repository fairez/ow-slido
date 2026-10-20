"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { NETWORK_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";

/** Host controls for the event's moderator link: generate/regenerate, copy, revoke. */
export function ModeratorLinkManager({ eventId, initialLink }: { eventId: string; initialLink: string | null }) {
  const t = useT();
  const [path, setPath] = useState<string | null>(initialLink);
  const [error, setError] = useState<string | null>(null);
  const url = path ? `${window.location.origin}${path}` : null;
  const endpoint = `/api/events/${eventId}/moderator-link`;

  const run = async (method: "POST" | "DELETE") => {
    setError(null);
    try {
      const res = await fetch(endpoint, { method });
      if (!res.ok) return setError(t("modLink.updateFailed"));
      setPath(method === "POST" ? ((await res.json()) as { link: string }).link : null);
    } catch {
      setError(NETWORK_ERROR);
    }
  };

  return (
    <section aria-labelledby="moderator-link-title" className="moderation">
      <h2 id="moderator-link-title">{t("modLink.title")}</h2>
      <p className="row-meta">{t("modLink.description")}</p>
      {error && <InlineError>{error}</InlineError>}
      {url && <input readOnly aria-label={t("modLink.title")} value={url} />}
      <div className="row-actions">
        <Button variant={path ? "secondary" : "primary"} onClick={() => void run("POST")}>
          {path ? t("modLink.regenerate") : t("modLink.generate")}
        </Button>
        {url && <Button onClick={() => void navigator.clipboard?.writeText(url)}>{t("modLink.copy")}</Button>}
        {path && (
          <Button variant="quiet" onClick={() => void run("DELETE")}>
            {t("modLink.revoke")}
          </Button>
        )}
      </div>
    </section>
  );
}
