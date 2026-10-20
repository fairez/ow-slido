"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";
import { joinEvent, participantPath } from "@/lib/join-client";

export function JoinForm() {
  const router = useRouter();
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    setPending(true);
    setError(null);
    const result = await joinEvent(code);
    if (result.ok) {
      router.push(participantPath(result.eventId));
      return;
    }
    setError(result.error);
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="entry-form">
      <TextField
        label={t("join.codeLabel")}
        name="code"
        className="code-input"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        required
        error={error ?? undefined}
      />
      <Button type="submit" variant="primary" busy={pending}>
        {pending ? t("join.submitting") : t("join.submit")}
      </Button>
    </form>
  );
}
