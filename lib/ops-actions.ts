import { and, eq, sql } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { memberships, subscriptions, users, workspaces } from "@/db/schema";
import { setSessionsValidAfter } from "@/lib/auth/password-reset";
import { disableTwoFactor, getTwoFactorStatus } from "@/lib/auth/two-factor";
import type { PlanId } from "@/lib/plans";
import { revokeMemberSockets } from "@/lib/realtime/publisher";

type Db = ReturnType<typeof createDb>["db"];

export const OPS_REASON_MAX = 300;
/** An override is a stop-gap; a date further out than this is almost certainly a typo. */
export const OPS_OVERRIDE_MAX_DAYS = 366;

export type OpsActionError = "not_found" | "reason" | "plan" | "until" | "already";
export type OpsResult<T = object> = ({ ok: true } & T) | { ok: false; error: OpsActionError };

/** Trimmed reason, or null when blank or too long. Reasons are required for every operator change. */
export function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= OPS_REASON_MAX ? value : null;
}

/** Stops the workspace: every member request and the audience screens of its events are refused until reactivated. */
export async function suspendWorkspace(db: Db, workspaceId: string, rawReason: unknown, now: Date = new Date()): Promise<OpsResult> {
  const reason = cleanReason(rawReason);
  if (!reason) return { ok: false, error: "reason" };
  const [updated] = await db
    .update(workspaces)
    .set({ suspendedAt: now, suspendedReason: reason })
    .where(and(eq(workspaces.id, workspaceId), sql`${workspaces.suspendedAt} is null`))
    .returning({ id: workspaces.id });
  if (!updated) {
    const [exists] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId));
    return { ok: false, error: exists ? "already" : "not_found" };
  }
  // Live host sockets must pass the access check again, which now fails.
  const members = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.workspaceId, workspaceId));
  for (const member of members) revokeMemberSockets(member.userId, workspaceId);
  return { ok: true };
}

export async function reactivateWorkspace(db: Db, workspaceId: string): Promise<OpsResult> {
  const [updated] = await db
    .update(workspaces)
    .set({ suspendedAt: null, suspendedReason: null })
    .where(and(eq(workspaces.id, workspaceId), sql`${workspaces.suspendedAt} is not null`))
    .returning({ id: workspaces.id });
  if (updated) return { ok: true };
  const [exists] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return { ok: false, error: exists ? "already" : "not_found" };
}

const PLAN_IDS: PlanId[] = ["free", "pro", "team"];

/**
 * Gives the workspace a plan that wins over its subscription until `until`. The end date and a reason are required,
 * so nothing stays on by accident. Stored in the subscription row's override columns (created for a Free workspace).
 */
export async function setPlanOverride(
  db: Db,
  workspaceId: string,
  input: { plan: unknown; until: unknown; reason: unknown },
  now: Date = new Date(),
): Promise<OpsResult<{ plan: PlanId; until: Date; reason: string }>> {
  const reason = cleanReason(input.reason);
  if (!reason) return { ok: false, error: "reason" };
  if (typeof input.plan !== "string" || !PLAN_IDS.includes(input.plan as PlanId)) return { ok: false, error: "plan" };
  const plan = input.plan as PlanId;
  const until = typeof input.until === "string" ? new Date(input.until) : null;
  const limit = now.getTime() + OPS_OVERRIDE_MAX_DAYS * 86_400_000;
  if (!until || Number.isNaN(until.getTime()) || until.getTime() <= now.getTime() || until.getTime() > limit) {
    return { ok: false, error: "until" };
  }
  const [workspace] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) return { ok: false, error: "not_found" };
  const columns = { planOverride: plan, planOverrideUntil: until, planOverrideReason: reason, updatedAt: now };
  await db
    .insert(subscriptions)
    .values({ workspaceId, ...columns })
    .onConflictDoUpdate({ target: subscriptions.workspaceId, set: columns });
  return { ok: true, plan, until, reason };
}

/** Ends an override early. The paid plan (or Free) applies again at once. */
export async function clearPlanOverride(db: Db, workspaceId: string, now: Date = new Date()): Promise<OpsResult> {
  const [updated] = await db
    .update(subscriptions)
    .set({ planOverride: null, planOverrideUntil: null, planOverrideReason: null, updatedAt: now })
    .where(and(eq(subscriptions.workspaceId, workspaceId), sql`${subscriptions.planOverride} is not null`))
    .returning({ id: subscriptions.id });
  return updated ? { ok: true } : { ok: false, error: "not_found" };
}

/**
 * Removes a member's authenticator secret and recovery codes (for someone locked out) and ends their other
 * sessions, so they sign in again with a password only. The person must belong to this workspace.
 */
export async function resetMemberTwoFactor(db: Db, workspaceId: string, userId: string): Promise<OpsResult<{ hadTwoFactor: boolean }>> {
  const [member] = await db
    .select({ id: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  if (!member) return { ok: false, error: "not_found" };
  const hadTwoFactor = (await getTwoFactorStatus(db, userId)).enabled;
  await disableTwoFactor(db, userId);
  await setSessionsValidAfter(db, userId);
  return { ok: true, hadTwoFactor };
}
