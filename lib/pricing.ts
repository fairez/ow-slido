import type { MessageKey, TParams } from "@/lib/i18n";
import { PLAN_IDS, PLAN_PRICES, PLANS, type BillingInterval, type PlanId } from "@/lib/plans";
import { TYPE_LABELS } from "@/lib/type-labels";

type Translate = (key: MessageKey, params?: TParams) => string;

export type PricingRow = { id: string; label: string; value: string };

export type PricingTier = {
  plan: PlanId;
  name: string;
  /** Formatted price per interval; null for the tier without a charge. */
  prices: Record<BillingInterval, string> | null;
  rows: PricingRow[];
};

const NAME_KEYS: Record<PlanId, MessageKey> = { free: "plan.name.free", pro: "plan.name.pro", team: "plan.name.team" };

/** Amounts are integer minor units (1/100 of the currency, as on the plan page); whole amounts print without decimals. */
function money(minor: number, currency: string, locale: string): string {
  const value = minor / 100;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

/**
 * The pricing page's content. Every number comes from `PLANS` and `PLAN_PRICES`; the page defines none.
 * Image storage and PDF/Excel reports are left out on purpose: they are in the plan limits but not built yet,
 * and a public page must not offer them. Reports are CSV and ZIP for every tier.
 */
export function buildPricing(locale: string, t: Translate): PricingTier[] {
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);
  const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  const yes = (on: boolean) => t(on ? "pricing.included" : "pricing.notIncluded");

  return PLAN_IDS.map((plan) => {
    const limits = PLANS[plan];
    const price = plan === "free" ? null : PLAN_PRICES[plan];
    const rows: PricingRow[] = [
      { id: "seats", label: t("pricing.row.seats"), value: num(limits.seats) },
      {
        id: "events",
        label: t("pricing.row.events"),
        value: limits.eventsPerMonth === null ? t("pricing.unlimited") : num(limits.eventsPerMonth),
      },
      { id: "participants", label: t("pricing.row.participants"), value: num(limits.participantsPerEvent) },
      {
        id: "types",
        label: t("pricing.row.types"),
        value: list.format(limits.allowedTypes.map((type) => t(TYPE_LABELS[type]))),
      },
      { id: "templates", label: t("pricing.row.templates"), value: num(limits.templates) },
      {
        id: "ai",
        label: t("pricing.row.ai"),
        value:
          limits.aiCallsPerMonth > 0
            ? t("pricing.aiValue", { event: num(limits.aiCallsPerEvent), month: num(limits.aiCallsPerMonth) })
            : t("pricing.notIncluded"),
      },
      { id: "branding", label: t("pricing.row.branding"), value: yes(limits.branding) },
      { id: "audit", label: t("pricing.row.audit"), value: yes(limits.auditLog) },
      { id: "twoFactor", label: t("pricing.row.twoFactor"), value: yes(limits.enforced2fa) },
    ];
    return {
      plan,
      name: t(NAME_KEYS[plan]),
      prices: price
        ? {
            month: t("plan.tier.month", { price: money(price.month, price.currency, locale) }),
            year: t("plan.tier.year", { price: money(price.year, price.currency, locale) }),
          }
        : null,
      rows,
    };
  });
}
