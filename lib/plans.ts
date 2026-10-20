import { eq } from "drizzle-orm";
import { subscriptions } from "@/db/schema";
import { getDb } from "@/lib/db";

export const PLAN_IDS = ["free", "pro", "team"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Includes types that ship in later stories (qa, ranking, quiz, survey) so the tiers are decided in one place. */
export type GatedInteractionType =
  | "poll"
  | "wordcloud"
  | "qa"
  | "rating"
  | "sharedNotes"
  | "openText"
  | "ranking"
  | "quiz"
  | "survey";

export type ReportFormat = "csv" | "pdf" | "xlsx";

export type PlanLimits = {
  /** People with an active membership, plus pending invitations. */
  seats: number;
  /** null = unlimited. */
  eventsPerMonth: number | null;
  participantsPerEvent: number;
  allowedTypes: readonly GatedInteractionType[];
  templates: number;
  imageStorageMb: number;
  aiCallsPerEvent: number;
  aiCallsPerMonth: number;
  reportFormats: readonly ReportFormat[];
  branding: boolean;
  auditLog: boolean;
  enforced2fa: boolean;
};

const BASIC_TYPES = ["poll", "wordcloud", "qa", "rating", "sharedNotes", "openText"] as const;
const ALL_TYPES = [...BASIC_TYPES, "ranking", "quiz", "survey"] as const;

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    seats: 1,
    eventsPerMonth: 3,
    participantsPerEvent: 100,
    allowedTypes: BASIC_TYPES,
    templates: 3,
    imageStorageMb: 0,
    aiCallsPerEvent: 0,
    aiCallsPerMonth: 0,
    reportFormats: ["csv"],
    branding: false,
    auditLog: false,
    enforced2fa: false,
  },
  pro: {
    seats: 3,
    eventsPerMonth: null,
    participantsPerEvent: 1000,
    allowedTypes: ALL_TYPES,
    templates: 50,
    imageStorageMb: 1024,
    aiCallsPerEvent: 20,
    aiCallsPerMonth: 300,
    reportFormats: ["csv", "pdf", "xlsx"],
    branding: false,
    auditLog: false,
    enforced2fa: false,
  },
  team: {
    seats: 15,
    eventsPerMonth: null,
    participantsPerEvent: 5000,
    allowedTypes: ALL_TYPES,
    templates: 500,
    imageStorageMb: 10240,
    aiCallsPerEvent: 50,
    aiCallsPerMonth: 1500,
    reportFormats: ["csv", "pdf", "xlsx"],
    branding: true,
    auditLog: true,
    enforced2fa: true,
  },
};

export type BillingInterval = "month" | "year";

/** Amounts are integer minor units (cents) of `currency`, an ISO 4217 code. Free has no price. */
export const PLAN_PRICES: Record<Exclude<PlanId, "free">, { currency: string; month: number; year: number }> = {
  pro: { currency: "USD", month: 1200, year: 12000 },
  team: { currency: "USD", month: 4900, year: 49000 },
};

/** How long a `past_due` workspace keeps its paid plan after the period it failed to pay for ended. */
export const PAST_DUE_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

/** The only place that decides month boundaries: calendar months in UTC, `end` exclusive. */
export function utcMonthBounds(now: Date = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export type SubscriptionRow = typeof subscriptions.$inferSelect;

export type Entitlements = {
  /** The plan whose limits apply right now. */
  plan: PlanId;
  /** Where `plan` came from: a valid override, the paid subscription, or the Free default. */
  source: "override" | "subscription" | "free";
  /** Stored subscription state, for the plan page and banners; null when the workspace has no row. */
  status: SubscriptionRow["status"] | null;
  interval: BillingInterval | null;
  currentPeriodEnd: Date | null;
  /** Set while `past_due` and still inside the grace period: when the paid plan ends. */
  graceEndsAt: Date | null;
  /** Set when a `canceled` subscription still has access: the last moment of paid access. */
  accessEndsAt: Date | null;
  limits: PlanLimits;
};

/**
 * Pure part of `getEntitlements`: which plan applies to this row at `now`.
 * - A valid override (not past `planOverrideUntil`) wins over everything.
 * - `active` and `trialing` give the stored plan.
 * - `past_due` keeps the stored plan until `currentPeriodEnd` + the grace days.
 * - `canceled` keeps the stored plan until `currentPeriodEnd`.
 * - No row, or any case not covered above, is Free.
 */
export function resolveEntitlements(row: SubscriptionRow | null, now: Date = new Date()): Entitlements {
  const base = {
    status: row?.status ?? null,
    interval: row?.interval ?? null,
    currentPeriodEnd: row?.currentPeriodEnd ?? null,
    graceEndsAt: null as Date | null,
    accessEndsAt: null as Date | null,
  };
  const done = (plan: PlanId, source: Entitlements["source"], extra: Partial<typeof base> = {}): Entitlements => ({
    ...base,
    ...extra,
    plan,
    source,
    limits: PLANS[plan],
  });

  if (!row) return done("free", "free");

  if (row.planOverride && (!row.planOverrideUntil || row.planOverrideUntil.getTime() > now.getTime())) {
    return done(row.planOverride, "override");
  }

  if (row.plan === "free") return done("free", "free");

  const end = row.currentPeriodEnd;
  switch (row.status) {
    case "active":
    case "trialing":
      return done(row.plan, "subscription");
    case "past_due": {
      const graceEndsAt = end ? new Date(end.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS) : null;
      if (graceEndsAt && graceEndsAt.getTime() > now.getTime()) return done(row.plan, "subscription", { graceEndsAt });
      return done("free", "free");
    }
    case "canceled":
      if (end && end.getTime() > now.getTime()) return done(row.plan, "subscription", { accessEndsAt: end });
      return done("free", "free");
  }
}

/** The only way code reads what a workspace may do. A workspace without a subscription row is on Free. */
export async function getEntitlements(
  workspaceId: string,
  options: { db?: Pick<ReturnType<typeof getDb>, "select">; now?: Date } = {},
): Promise<Entitlements> {
  const db = options.db ?? getDb();
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
  return resolveEntitlements(row ?? null, options.now);
}
