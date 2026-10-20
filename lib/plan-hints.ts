import { PLANS, cheapestPlan, type GatedInteractionType, type PlanId, type PlanLimits, type ReportFormat } from "@/lib/plans";

/** A gated action the current plan does not include. `requiredPlan` is null when no tier would allow it. */
export type Lock = { requiredPlan: PlanId | null };

/** Interaction types the plan leaves out, each with the cheapest tier that has it. */
export function lockedTypes(limits: PlanLimits): Partial<Record<GatedInteractionType, Lock>> {
  const locks: Partial<Record<GatedInteractionType, Lock>> = {};
  for (const type of PLANS.team.allowedTypes) {
    if (!limits.allowedTypes.includes(type)) locks[type] = { requiredPlan: cheapestPlan((p) => PLANS[p].allowedTypes.includes(type)) };
  }
  return locks;
}

export function lockedFormats(limits: PlanLimits): Partial<Record<ReportFormat, Lock>> {
  const locks: Partial<Record<ReportFormat, Lock>> = {};
  for (const format of PLANS.team.reportFormats) {
    if (!limits.reportFormats.includes(format)) locks[format] = { requiredPlan: cheapestPlan((p) => PLANS[p].reportFormats.includes(format)) };
  }
  return locks;
}

/** Set when the plan has no AI calls at all. Running out of calls is reported by the server when a run starts. */
export function aiLock(limits: PlanLimits): Lock | undefined {
  if (limits.aiCallsPerEvent > 0 && limits.aiCallsPerMonth > 0) return undefined;
  return { requiredPlan: cheapestPlan((p) => PLANS[p].aiCallsPerEvent > 0 && PLANS[p].aiCallsPerMonth > 0) };
}

/** Set when every seat is taken, so the invite button turns into a pointer to the plan page. */
export function seatLock(limits: PlanLimits, seatsUsed: number): Lock | undefined {
  if (seatsUsed < limits.seats) return undefined;
  return { requiredPlan: cheapestPlan((p) => PLANS[p].seats > seatsUsed) };
}

/** The tier that holds more templates than the current plan; shown once every template slot is used. */
export function templateLock(limits: PlanLimits): Lock {
  return { requiredPlan: cheapestPlan((p) => PLANS[p].templates > limits.templates) };
}

/** Set when the plan cannot require 2FA, so the switch on the members page becomes a pointer to the plan page. */
export function twoFactorLock(limits: PlanLimits): Lock | undefined {
  if (limits.enforced2fa) return undefined;
  return { requiredPlan: cheapestPlan((p) => PLANS[p].enforced2fa) };
}

/** Set when the plan has no audit log page, so the page shows a pointer to the plan page instead of entries. */
export function auditLogLock(limits: PlanLimits): Lock | undefined {
  if (limits.auditLog) return undefined;
  return { requiredPlan: cheapestPlan((p) => PLANS[p].auditLog) };
}
