"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useLocale, useT } from "@/lib/i18n/client";
import { LOCALES, storeAudienceLocale, type Locale } from "@/lib/i18n/locale";

/** Lets a participant read this event in the other language; the choice is a cookie for this event only. */
export function AudienceLanguage({ eventId }: { eventId: string }) {
  const t = useT();
  const router = useRouter();
  const current = useLocale();

  function choose(locale: Locale) {
    if (locale === current) return;
    storeAudienceLocale(eventId, locale);
    router.refresh();
  }

  return (
    <div role="group" aria-label={t("language.switchLabel")} className="audience-language">
      {LOCALES.map((locale) => (
        <Button key={locale} variant="quiet" lang={locale} aria-pressed={locale === current} onClick={() => choose(locale)}>
          {t(`language.name.${locale}`)}
        </Button>
      ))}
    </div>
  );
}
