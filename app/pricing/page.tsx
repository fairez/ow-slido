import type { Metadata } from "next";
import { PricingPlans } from "@/components/pricing-plans";
import { getLocale, getT } from "@/lib/i18n/server";
import { buildPricing } from "@/lib/pricing";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: `${t("pricing.title")} · ${t("shell.brand")}` };
}

export default async function PricingPage() {
  const [locale, t] = await Promise.all([getLocale(), getT()]);
  return (
    <main id="main" className="pricing-page">
      <h1>{t("pricing.title")}</h1>
      <p className="pricing-lead">{t("pricing.lead")}</p>
      <PricingPlans tiers={buildPricing(locale, t)} />
      <p className="pricing-note">{t("pricing.note")}</p>
    </main>
  );
}
