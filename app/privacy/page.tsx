import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { getLocale, getT } from "@/lib/i18n/server";
import { PRIVACY_SECTIONS } from "@/lib/legal";
import { RETENTION_NOTICE_DAYS, RETENTION_OPTIONS } from "@/lib/retention-schedule";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: `${t("legal.privacy.title")} · ${t("shell.brand")}` };
}

export default async function PrivacyPage() {
  const [locale, t] = await Promise.all([getLocale(), getT()]);
  // The periods come from the retention setting itself, so this text cannot drift from what hosts can choose.
  const days = new Intl.ListFormat(locale, { type: "disjunction" }).format(RETENTION_OPTIONS.map(String));
  return (
    <LegalPage
      title={t("legal.privacy.title")}
      lead={t("legal.privacy.lead")}
      sections={PRIVACY_SECTIONS}
      t={t}
      params={{ days, notice: RETENTION_NOTICE_DAYS }}
    />
  );
}
