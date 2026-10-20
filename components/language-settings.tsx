"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { NETWORK_ERROR } from "@/lib/copy";
import { useLocale, useT } from "@/lib/i18n/client";
import { LOCALES, type Locale } from "@/lib/i18n/locale";

/** The signed-in user's interface language: saved on the account and mirrored in the `lang` cookie. */
export function LanguageSettings() {
  const t = useT();
  const router = useRouter();
  const current = useLocale();
  const [choice, setChoice] = useState<Locale>(current);
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
      const response = await fetch("/api/auth/locale", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: choice }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof body?.error === "string" ? body.error : t("error.server"));
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="language-heading" className="member-policy">
      <h2 id="language-heading">{t("language.settingsTitle")}</h2>
      <p className="row-meta">{t("language.settingsLead")}</p>
      <form onSubmit={save} className="retention-form">
        <fieldset className="retention-options">
          <legend>{t("language.label")}</legend>
          {LOCALES.map((locale) => (
            <label key={locale} className="retention-option">
              <input
                type="radio"
                name="locale"
                value={locale}
                checked={choice === locale}
                onChange={() => {
                  setChoice(locale);
                  setDone(false);
                }}
              />
              <span lang={locale}>{t(`language.name.${locale}`)}</span>
            </label>
          ))}
        </fieldset>
        <div>
          <Button type="submit" variant="primary" busy={pending}>
            {pending ? t("language.saving") : t("language.save")}
          </Button>
        </div>
        {done && (
          <p role="status" className="retention-saved">
            {t("language.saved")}
          </p>
        )}
        {error && <InlineError>{error}</InlineError>}
      </form>
    </section>
  );
}
