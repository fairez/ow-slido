"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";

type State = "idle" | "sending" | "sent" | "failed";

export function VerifyBanner({ email }: { email: string }) {
  const t = useT();
  const [state, setState] = useState<State>("idle");

  async function resend() {
    setState("sending");
    try {
      const res = await fetch("/api/auth/verify/resend", { method: "POST" });
      setState(res.ok ? "sent" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="verify-banner">
      <p>{t("verify.banner", { email })}</p>
      <Button variant="secondary" busy={state === "sending"} disabled={state === "sent"} onClick={resend}>
        {state === "sent" ? t("verify.sent") : t("verify.resend")}
      </Button>
      {state === "failed" && <p role="alert">{t("verify.resendFailed")}</p>}
    </div>
  );
}
