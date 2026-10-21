"use client";

import Link from "next/link";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import type { PricingTier } from "@/lib/pricing";
import type { BillingInterval } from "@/lib/plans";

/** The tiers with a monthly/yearly toggle. Nothing is highlighted: no tier is the one we want everybody on. */
export function PricingPlans({ tiers }: { tiers: PricingTier[] }) {
  const t = useT();
  const [interval, setInterval] = useState<BillingInterval>("month");

  return (
    <>
      <fieldset className="interval-toggle">
        <legend className="sr-only">{t("plan.interval.legend")}</legend>
        {(["month", "year"] as const).map((value) => (
          <label key={value} data-checked={interval === value || undefined}>
            <input type="radio" name="interval" value={value} checked={interval === value} onChange={() => setInterval(value)} />
            {t(value === "month" ? "plan.interval.month" : "plan.interval.year")}
          </label>
        ))}
      </fieldset>
      <ul className="pricing-list">
        {tiers.map((tier) => (
          <li key={tier.plan} className="pricing-tier">
            <div className="pricing-tier-head">
              <h2>{tier.name}</h2>
              <p className="pricing-price" aria-live="polite">
                {tier.prices ? tier.prices[interval] : t("plan.tier.free")}
              </p>
              <Link className="ui-button" data-variant={tier.plan === "free" ? "primary" : undefined} href="/signup">
                {tier.plan === "free" ? t("pricing.signupFree") : t("pricing.signupPlan", { plan: tier.name })}
              </Link>
            </div>
            <dl className="pricing-rows">
              {tier.rows.map((row) => (
                <div key={row.id} className="pricing-row">
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
