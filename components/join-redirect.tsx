"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AudienceLanguage } from "@/components/audience-language";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";
import { joinEvent, participantPath } from "@/lib/join-client";

/** After a successful join, how long to wait for the participant page before offering a manual link. */
export const NAVIGATION_STALL_MS = 12_000;

export function JoinRedirect({ code, eventId, cookiesBlocked = false }: { code: string; eventId?: string; cookiesBlocked?: boolean }) {
  const router = useRouter();
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [stalledAt, setStalledAt] = useState<string | null>(null);

  useEffect(() => {
    if (cookiesBlocked) return;
    let cancelled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    joinEvent(code).then((result) => {
      if (cancelled) return;
      if (!result.ok) return setError(result.error);
      const path = participantPath(result.eventId);
      router.replace(path);
      stallTimer = setTimeout(() => setStalledAt(path), NAVIGATION_STALL_MS);
    });
    return () => {
      cancelled = true;
      clearTimeout(stallTimer);
    };
  }, [code, router, cookiesBlocked]);

  const language = eventId ? <AudienceLanguage eventId={eventId} /> : null;

  if (cookiesBlocked) {
    return (
      <>
        <h1>{t("join.cookiesTitle")}</h1>
        <InlineError>{t("join.cookiesBlocked")}</InlineError>
        <p className="entry-alt">
          <a href={`/join/${code}`}>{t("join.tryAgain")}</a>
        </p>
        {language}
      </>
    );
  }

  if (error) {
    return (
      <>
        <h1>{t("join.failedTitle")}</h1>
        <InlineError>{error}</InlineError>
        <div className="entry-actions">
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t("join.tryAgain")}
          </Button>
        </div>
        <p className="entry-alt">
          <Link href="/">{t("join.enterCode")}</Link>
        </p>
        {language}
      </>
    );
  }

  return (
    <>
      <h1>{t("join.title")}</h1>
      <p role="status" className="entry-lead">
        {t("join.checking", { code })}
      </p>
      {stalledAt ? (
        <p className="entry-alt">
          <a href={stalledAt}>{t("join.continue")}</a>
        </p>
      ) : (
        // Shown by CSS after a delay, so it still appears when scripts never run (old browser, blocked bundle).
        <p className="join-stuck" role="status">
          {t("join.stuck")}
        </p>
      )}
      <noscript>
        <p className="join-noscript">{t("join.noscript")}</p>
      </noscript>
      {language}
    </>
  );
}
