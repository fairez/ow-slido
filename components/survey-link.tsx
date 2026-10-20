"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";

/** Copies the survey's own link; the confirmation is spoken through a polite status. */
export function SurveyLinkButton({ interactionId, title }: { interactionId: string; title: string }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/survey/${interactionId}`);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <Button variant="quiet" aria-label={t("survey.copyLinkFor", { title })} onClick={() => void copy()}>
        {t("survey.copyLink")}
      </Button>
      <span className="field-meta" aria-live="polite">
        {state === "copied" ? t("survey.linkCopied") : state === "failed" ? t("survey.linkCopyFailed") : ""}
      </span>
    </>
  );
}
