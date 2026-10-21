import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { getT } from "@/lib/i18n/server";
import { TERMS_SECTIONS } from "@/lib/legal";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: `${t("legal.terms.title")} · ${t("shell.brand")}` };
}

export default async function TermsPage() {
  const t = await getT();
  return <LegalPage title={t("legal.terms.title")} lead={t("legal.terms.lead")} sections={TERMS_SECTIONS} t={t} />;
}
