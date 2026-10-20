"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n/client";
import type { Lock } from "@/lib/plan-hints";

const NAME_KEYS = { free: "plan.name.free", pro: "plan.name.pro", team: "plan.name.team" } as const;

/**
 * Stands in for a control the plan does not include. It names the tier that unlocks the action and
 * links to the plan page, so the action stays discoverable instead of vanishing.
 */
export function PlanHint({ lock, children }: { lock: Lock; children: ReactNode }) {
  const t = useT();
  const tier = lock.requiredPlan ? t("plan.hint.tier", { plan: t(NAME_KEYS[lock.requiredPlan]) }) : t("plan.hint.limit");
  return (
    <Link href="/dashboard/plan" className="ui-button plan-hint">
      <span>{children}</span>{" "}
      <span className="plan-hint-tier">{tier}</span>
    </Link>
  );
}
