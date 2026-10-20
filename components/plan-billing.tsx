"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { InlineError } from "@/components/ui/field";
import { goTo } from "@/lib/go-to";
import { useT } from "@/lib/i18n/client";
import type { PlanId } from "@/lib/plans";

type Interval = "month" | "year";

async function post(url: string, body: unknown, fallback: string): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return { ok: true, data };
    return { ok: false, error: typeof data.error === "string" ? data.error : fallback };
  } catch {
    return { ok: false, error: fallback };
  }
}

/** Opens the provider's billing portal in this tab. */
export function PortalButton({ variant = "secondary" }: { variant?: "primary" | "secondary" }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    const result = await post("/api/billing/portal", {}, t("error.network"));
    if (result.ok && typeof result.data.url === "string") {
      goTo(result.data.url);
      return;
    }
    setBusy(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <>
      <Button variant={variant} busy={busy} onClick={open}>
        {t("plan.manage")}
      </Button>
      {error && <InlineError>{error}</InlineError>}
    </>
  );
}

/** Stops renewal after a confirmation that names the date paid access ends. */
export function CancelPlan({ planName, accessEnd }: { planName: string; accessEnd: string }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function cancel() {
    setBusy(true);
    setError(null);
    const result = await post("/api/billing/cancel", {}, t("error.network"));
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    setDone(true);
    router.refresh();
  }

  if (done) {
    return (
      <p className="row-meta" role="status">
        {t("plan.cancel.done", { plan: planName, date: accessEnd })}
      </p>
    );
  }

  return (
    <>
      <Button variant="quiet" onClick={() => setOpen(true)}>
        {t("plan.cancel.button")}
      </Button>
      <Dialog open={open} title={t("plan.cancel.title", { plan: planName })} onClose={() => setOpen(false)}>
        <div className="form-stack">
          <p>{t("plan.cancel.body", { plan: planName, date: accessEnd })}</p>
          {error && <InlineError>{error}</InlineError>}
          <div className="row-actions">
            <Button variant="primary" busy={busy} onClick={cancel}>
              {t("plan.cancel.confirm")}
            </Button>
            <Button onClick={() => setOpen(false)}>{t("plan.cancel.keep", { plan: planName })}</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

export type TierView = {
  plan: PlanId;
  name: string;
  current: boolean;
  facts: string[];
  /** Formatted price per interval; null for the tier without a charge. */
  prices: Record<Interval, string> | null;
  /** The button, if any: a paid tier other than the current one. */
  action: "upgrade" | "switch" | null;
};

/** The tier list with its monthly/yearly toggle. Prices and buttons only reach roles that manage billing. */
export function PlanTiers({
  tiers,
  showPrices,
  canChange,
  changeVia,
}: {
  tiers: TierView[];
  showPrices: boolean;
  /** Billing is set up, so the buttons work. */
  canChange: boolean;
  changeVia: "checkout" | "portal";
}) {
  const t = useT();
  const [interval, setInterval] = useState<Interval>("month");
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(plan: PlanId) {
    setBusy(plan);
    setError(null);
    const result =
      changeVia === "portal"
        ? await post("/api/billing/portal", {}, t("error.network"))
        : await post("/api/billing/checkout", { plan, interval }, t("error.network"));
    if (result.ok && typeof result.data.url === "string") {
      goTo(result.data.url);
      return;
    }
    setBusy(null);
    if (!result.ok) setError(result.error);
  }

  const tierName = (plan: PlanId) => tiers.find((tier) => tier.plan === plan)?.name ?? plan;

  return (
    <>
      {showPrices && (
        <fieldset className="interval-toggle">
          <legend className="sr-only">{t("plan.interval.legend")}</legend>
          {(["month", "year"] as const).map((value) => (
            <label key={value} data-checked={interval === value || undefined}>
              <input type="radio" name="interval" value={value} checked={interval === value} onChange={() => setInterval(value)} />
              {t(value === "month" ? "plan.interval.month" : "plan.interval.year")}
            </label>
          ))}
        </fieldset>
      )}
      <ul className="row-list" aria-busy={busy !== null || undefined}>
        {tiers.map((tier) => (
          <li key={tier.plan} className="plan-tier" data-current={tier.current || undefined}>
            <div className="plan-tier-head">
              <h3 className="event-name">{tier.name}</h3>
              {tier.current && <Badge tone="accent">{t("plan.tier.current")}</Badge>}
            </div>
            {showPrices && <p className="plan-tier-price">{tier.prices ? tier.prices[interval] : t("plan.tier.free")}</p>}
            <ul className="plan-facts">
              {tier.facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
            {showPrices && canChange && tier.action && (
              <Button
                busy={busy === tier.plan}
                disabled={busy !== null}
                onClick={() => choose(tier.plan)}
              >
                {t(tier.action === "upgrade" ? "plan.action.upgrade" : "plan.action.switch", { plan: tierName(tier.plan) })}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <InlineError>{error}</InlineError>}
    </>
  );
}
