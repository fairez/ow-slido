import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { MessageKey, TParams } from "@/lib/i18n";
import { PLAN_IDS, PLAN_PRICES, PLANS, cheapestPlan, type Entitlements, type PlanId } from "@/lib/plans";
import type { WorkspaceUsage } from "@/lib/usage";

type Translate = (key: MessageKey, params?: TParams) => string;
type Format = (n: number) => string;

const NAME_KEYS: Record<PlanId, MessageKey> = { free: "plan.name.free", pro: "plan.name.pro", team: "plan.name.team" };
const day = (date: Date) => date.toISOString().slice(0, 10);

function size(mb: number) {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
}

type Meter = {
  key: string;
  label: MessageKey;
  used: number;
  /** null = no limit; 0 = the plan does not include it. */
  limit: number | null;
  figures: (used: number, limit: number) => string;
  /** Cheapest tier that includes it, for a limit of 0. */
  startsAt: PlanId | null;
};

function meters(entitlements: Entitlements, usage: WorkspaceUsage, t: Translate, num: Format): Meter[] {
  const { limits } = entitlements;
  const of = (used: number, limit: number) => t("plan.usage.of", { used: num(used), limit: num(limit) });
  return [
    { key: "seats", label: "plan.usage.seats", used: usage.seats, limit: limits.seats, figures: of, startsAt: null },
    {
      key: "events",
      label: "plan.usage.events",
      used: usage.eventsThisMonth,
      limit: limits.eventsPerMonth,
      figures: of,
      startsAt: null,
    },
    {
      key: "participants",
      label: "plan.usage.participants",
      used: usage.participantsPeak,
      limit: limits.participantsPerEvent,
      figures: of,
      startsAt: null,
    },
    {
      key: "ai",
      label: "plan.usage.ai",
      used: usage.aiCallsThisMonth,
      limit: limits.aiCallsPerMonth,
      figures: of,
      startsAt: cheapestPlan((p) => PLANS[p].aiCallsPerMonth > 0),
    },
    {
      key: "storage",
      label: "plan.usage.storage",
      used: usage.storageMb,
      limit: limits.imageStorageMb,
      figures: (used, limit) => t("plan.usage.of", { used: size(used), limit: size(limit) }),
      startsAt: cheapestPlan((p) => PLANS[p].imageStorageMb > 0),
    },
  ];
}

function UsageRow({ meter, t, num }: { meter: Meter; t: Translate; num: Format }) {
  const labelId = `meter-${meter.key}`;
  const { used, limit } = meter;

  if (limit === 0) {
    return (
      <li className="meter-row">
        <span id={labelId} className="meter-label">{t(meter.label)}</span>
        <p className="row-meta">
          {meter.startsAt
            ? t("plan.usage.notIncluded", { plan: t(NAME_KEYS[meter.startsAt]) })
            : t("plan.usage.notAnywhere")}
        </p>
      </li>
    );
  }

  if (limit === null) {
    return (
      <li className="meter-row">
        <span id={labelId} className="meter-label">{t(meter.label)}</span>
        <p className="meter-figures">{t("plan.usage.unlimited", { used: num(used) })}</p>
      </li>
    );
  }

  const figures = meter.figures(used, limit);
  const full = used >= limit;
  return (
    <li className="meter-row">
      <div className="meter-head">
        <span id={labelId} className="meter-label">{t(meter.label)}</span>
        <span className="meter-figures">{figures}</span>
      </div>
      <progress
        className="meter"
        value={Math.min(used, limit)}
        max={limit}
        data-full={full || undefined}
        aria-labelledby={labelId}
        aria-valuetext={figures}
      />
      {full && <p className="row-meta">{t("plan.usage.atLimit")}</p>}
    </li>
  );
}

function facts(plan: PlanId, t: Translate, num: Format): string[] {
  const l = PLANS[plan];
  return [
    t(l.seats === 1 ? "plan.fact.seats.one" : "plan.fact.seats.other", { n: num(l.seats) }),
    l.eventsPerMonth === null ? t("plan.fact.eventsUnlimited") : t("plan.fact.events", { n: num(l.eventsPerMonth) }),
    t("plan.fact.participants", { n: num(l.participantsPerEvent) }),
    l.aiCallsPerMonth > 0 ? t("plan.fact.ai", { event: num(l.aiCallsPerEvent), month: num(l.aiCallsPerMonth) }) : t("plan.fact.noAi"),
    l.imageStorageMb > 0 ? t("plan.fact.storage", { size: size(l.imageStorageMb) }) : t("plan.fact.noStorage"),
    t("plan.fact.reports", { formats: l.reportFormats.map((f) => f.toUpperCase()).join(", ") }),
  ];
}

function price(plan: PlanId, locale: string, t: Translate) {
  if (plan === "free") return [t("plan.tier.free")];
  const p = PLAN_PRICES[plan];
  const money = (minor: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: p.currency, minimumFractionDigits: 0 }).format(minor / 100);
  return [t("plan.tier.month", { price: money(p.month) }), t("plan.tier.year", { price: money(p.year) })];
}

function statusNote(e: Entitlements, t: Translate): string | null {
  const plan = t(NAME_KEYS[e.plan]);
  if (e.source === "override") return t("plan.source.override");
  if (e.graceEndsAt) return t("plan.pastDue", { plan, date: day(e.graceEndsAt) });
  if (e.accessEndsAt) return t("plan.canceled", { plan, date: day(e.accessEndsAt) });
  if (e.source === "subscription" && e.currentPeriodEnd) return t("plan.periodEnds", { date: day(e.currentPeriodEnd) });
  return null;
}

/** Read-only view of the plan and usage. Price and the change buttons appear only when `canManageBilling`. */
export function PlanOverview({
  entitlements,
  usage,
  canManageBilling,
  locale,
  t,
}: {
  entitlements: Entitlements;
  usage: WorkspaceUsage;
  canManageBilling: boolean;
  locale: string;
  t: Translate;
}) {
  const num: Format = (n) => new Intl.NumberFormat(locale).format(n);
  const note = statusNote(entitlements, t);
  const currentIndex = PLAN_IDS.indexOf(entitlements.plan);
  return (
    <div className="stack">
      <section aria-labelledby="current-plan-heading" className="plan-current">
        <h2 id="current-plan-heading">{t("plan.currentTitle")}</h2>
        <p className="plan-current-name">{t(NAME_KEYS[entitlements.plan])}</p>
        {note && <p className="row-meta">{note}</p>}
      </section>

      <section aria-labelledby="usage-heading">
        <h2 id="usage-heading">{t("plan.usageTitle")}</h2>
        <p className="row-meta">{t("plan.usageLead")}</p>
        <ul className="meter-list">
          {meters(entitlements, usage, t, num).map((meter) => (
            <UsageRow key={meter.key} meter={meter} t={t} num={num} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="tiers-heading">
        <h2 id="tiers-heading">{t("plan.tiersTitle")}</h2>
        <ul className="row-list">
          {PLAN_IDS.map((plan, index) => {
            const current = plan === entitlements.plan;
            return (
              <li key={plan} className="plan-tier" data-current={current || undefined}>
                <div className="plan-tier-head">
                  <h3 className="event-name">{t(NAME_KEYS[plan])}</h3>
                  {current && <Badge tone="accent">{t("plan.tier.current")}</Badge>}
                </div>
                {canManageBilling && <p className="plan-tier-price">{price(plan, locale, t).join(", ")}</p>}
                <ul className="plan-facts">
                  {facts(plan, t, num).map((fact) => (
                    <li key={fact}>{fact}</li>
                  ))}
                </ul>
                {canManageBilling && !current && (
                  // TODO(US-024): the upgrade and cancel flow replaces these with working actions.
                  <Button disabled aria-describedby="plan-change-note">
                    {t(index > currentIndex ? "plan.action.upgrade" : "plan.action.switch", { plan: t(NAME_KEYS[plan]) })}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {canManageBilling ? (
          <p id="plan-change-note" className="row-meta">{t("plan.action.soon")}</p>
        ) : (
          <p className="row-meta">{t("plan.readonly")}</p>
        )}
      </section>
    </div>
  );
}

