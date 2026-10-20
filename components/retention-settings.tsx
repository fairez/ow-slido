"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { NETWORK_ERROR } from "@/lib/copy";
import { useT } from "@/lib/i18n/client";
import { RETENTION_OPTIONS } from "@/lib/retention-schedule";

type Choice = number | null;

export function RetentionSettings({ initial }: { initial: Choice }) {
  const t = useT();
  const [choice, setChoice] = useState<Choice>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setDone(false);
    try {
      const response = await fetch("/api/workspaces/active/retention", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retentionDays: choice }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof body?.error === "string" ? body.error : t("retention.saveFailed"));
        return;
      }
      setDone(true);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  const options: Choice[] = [...RETENTION_OPTIONS, null];

  return (
    <section aria-labelledby="retention-heading" className="member-policy">
      <h2 id="retention-heading">{t("retention.title")}</h2>
      <p className="row-meta">{t("retention.lead")}</p>
      <form onSubmit={save} className="retention-form">
        <fieldset className="retention-options">
          <legend>{t("retention.legend")}</legend>
          {options.map((days) => (
            <label key={days ?? "keep"} className="retention-option">
              <input
                type="radio"
                name="retentionDays"
                value={days ?? "keep"}
                checked={choice === days}
                onChange={() => {
                  setChoice(days);
                  setDone(false);
                }}
              />
              <span>{days === null ? t("retention.keep") : t("retention.days", { count: days })}</span>
            </label>
          ))}
        </fieldset>
        <p className="row-meta" data-testid="retention-effect">
          {choice === null ? t("retention.effect.keep") : t("retention.effect.days", { count: choice })}
        </p>
        <div>
          <Button type="submit" variant="primary" busy={pending}>
            {pending ? t("retention.saving") : t("retention.save")}
          </Button>
        </div>
        {done && (
          <p role="status" className="retention-saved">
            {t("retention.saved")}
          </p>
        )}
        {error && <InlineError>{error}</InlineError>}
      </form>
    </section>
  );
}
