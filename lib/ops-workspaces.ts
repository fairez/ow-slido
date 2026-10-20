import { and, asc, count, desc, eq, exists, gt, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { aiCalls, events, invitations, memberships, subscriptions, userTotp, users, workspaces } from "@/db/schema";
import { escapeLike } from "@/lib/audit-query";
import { resolveEntitlements, utcMonthBounds, type PlanId, type SubscriptionRow } from "@/lib/plans";

type Db = ReturnType<typeof createDb>["db"];

export const OPS_PAGE_SIZE = 25;

export type OpsWorkspace = {
  id: string;
  name: string;
  /** The plan whose limits apply now (override and grace included). */
  plan: PlanId;
  /** Stored subscription state; null for a workspace that never had a subscription. */
  status: SubscriptionRow["status"] | null;
  /** Active members plus pending invitations, like the seat limit counts. */
  seatsUsed: number;
  /** Active members. */
  members: number;
  eventsThisMonth: number;
  aiCallsThisMonth: number;
  /** Email of the longest-standing owner; null when the workspace has none. */
  ownerEmail: string | null;
  /** Set while the operator has the workspace suspended. */
  suspendedAt: Date | null;
  createdAt: Date;
};

export type OpsWorkspacePage = { workspaces: OpsWorkspace[]; total: number; page: number; pageSize: number };

export type OpsFilters = { q?: string; page?: number };

/** Parses the query string of the list API; `error` names the unusable parameter. */
export function parseOpsFilters(params: URLSearchParams): { ok: true; value: OpsFilters } | { ok: false; error: "page" } {
  const value: OpsFilters = {};
  const q = params.get("q")?.trim();
  if (q) value.q = q.slice(0, 200);
  const rawPage = params.get("page");
  if (rawPage) {
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1 || page > 100_000) return { ok: false, error: "page" };
    value.page = page;
  }
  return { ok: true, value };
}

/**
 * Workspaces for the operator console, newest first, `OPS_PAGE_SIZE` at a time. `q` matches the workspace name or
 * the email of any of its owners (a literal substring, any case). Counts for the month follow `utcMonthBounds`.
 * AI calls are attributed through the event, like the plan page does, so calls of deleted events are not counted.
 */
export async function listOpsWorkspaces(db: Db, filters: OpsFilters = {}, now: Date = new Date()): Promise<OpsWorkspacePage> {
  const page = filters.page ?? 1;
  const conditions: SQL[] = [];
  if (filters.q) {
    const like = `%${escapeLike(filters.q)}%`;
    const ownerMatch = exists(
      db
        .select({ one: sql`1` })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.workspaceId, workspaces.id), eq(memberships.role, "owner"), ilike(users.email, like))),
    );
    conditions.push(or(ilike(workspaces.name, like), ownerMatch) as SQL);
  }
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ workspace: workspaces, subscription: subscriptions })
      .from(workspaces)
      .leftJoin(subscriptions, eq(subscriptions.workspaceId, workspaces.id))
      .where(where)
      .orderBy(desc(workspaces.createdAt), asc(workspaces.id))
      .limit(OPS_PAGE_SIZE)
      .offset((page - 1) * OPS_PAGE_SIZE),
    db.select({ total: count() }).from(workspaces).where(where),
  ]);
  if (rows.length === 0) return { workspaces: [], total, page, pageSize: OPS_PAGE_SIZE };

  const ids = rows.map((r) => r.workspace.id);
  const { start, end } = utcMonthBounds(now);
  const [memberRows, inviteRows, eventRows, aiRows, ownerRows] = await Promise.all([
    db
      .select({ id: memberships.workspaceId, n: count() })
      .from(memberships)
      .where(and(inArray(memberships.workspaceId, ids), eq(memberships.status, "active")))
      .groupBy(memberships.workspaceId),
    db
      .select({ id: invitations.workspaceId, n: count() })
      .from(invitations)
      .where(and(inArray(invitations.workspaceId, ids), eq(invitations.status, "pending"), gt(invitations.expiresAt, now)))
      .groupBy(invitations.workspaceId),
    db
      .select({ id: events.workspaceId, n: count() })
      .from(events)
      .where(and(inArray(events.workspaceId, ids), gte(events.createdAt, start), lt(events.createdAt, end)))
      .groupBy(events.workspaceId),
    db
      .select({ id: events.workspaceId, n: count() })
      .from(aiCalls)
      .innerJoin(events, eq(events.id, aiCalls.eventId))
      .where(and(inArray(events.workspaceId, ids), gte(aiCalls.createdAt, start), lt(aiCalls.createdAt, end)))
      .groupBy(events.workspaceId),
    db
      .select({ id: memberships.workspaceId, email: users.email, createdAt: memberships.createdAt })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(inArray(memberships.workspaceId, ids), eq(memberships.role, "owner")))
      .orderBy(asc(memberships.createdAt), asc(users.email)),
  ]);
  const byId = (list: { id: string; n: number }[]) => new Map(list.map((r) => [r.id, r.n]));
  const members = byId(memberRows);
  const pending = byId(inviteRows);
  const eventCounts = byId(eventRows);
  const aiCounts = byId(aiRows);
  const owners = new Map<string, string>();
  for (const r of ownerRows) if (!owners.has(r.id)) owners.set(r.id, r.email);

  return {
    workspaces: rows.map(({ workspace, subscription }) => {
      const entitlements = resolveEntitlements(subscription, now);
      return {
        id: workspace.id,
        name: workspace.name,
        plan: entitlements.plan,
        status: entitlements.status,
        seatsUsed: (members.get(workspace.id) ?? 0) + (pending.get(workspace.id) ?? 0),
        members: members.get(workspace.id) ?? 0,
        eventsThisMonth: eventCounts.get(workspace.id) ?? 0,
        aiCallsThisMonth: aiCounts.get(workspace.id) ?? 0,
        ownerEmail: owners.get(workspace.id) ?? null,
        suspendedAt: workspace.suspendedAt,
        createdAt: workspace.createdAt,
      };
    }),
    total,
    page,
    pageSize: OPS_PAGE_SIZE,
  };
}

export type OpsMember = {
  userId: string;
  email: string;
  role: "owner" | "admin" | "editor" | "moderator" | "viewer";
  status: "active" | "suspended";
  twoFactor: boolean;
};

export type OpsWorkspaceDetail = {
  id: string;
  name: string;
  plan: PlanId;
  /** Where the effective plan comes from; `override` while a manual plan is in force. */
  source: "override" | "subscription" | "free";
  suspendedAt: Date | null;
  suspendedReason: string | null;
  /** The stored override, even when it has already ended (`overrideActive` tells). */
  override: { plan: PlanId; until: Date | null; reason: string | null; active: boolean } | null;
  members: OpsMember[];
};

/** One workspace with what the operator may act on: suspension, plan override and its members' 2FA state. */
export async function getOpsWorkspaceDetail(db: Db, id: string, now: Date = new Date()): Promise<OpsWorkspaceDetail | null> {
  const [row] = await db
    .select({ workspace: workspaces, subscription: subscriptions })
    .from(workspaces)
    .leftJoin(subscriptions, eq(subscriptions.workspaceId, workspaces.id))
    .where(eq(workspaces.id, id));
  if (!row) return null;
  const { workspace, subscription } = row;
  const entitlements = resolveEntitlements(subscription, now);
  const memberRows = await db
    .select({
      userId: users.id,
      email: users.email,
      role: memberships.role,
      status: memberships.status,
      confirmedAt: userTotp.confirmedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(userTotp, eq(userTotp.userId, users.id))
    .where(eq(memberships.workspaceId, id))
    .orderBy(asc(memberships.createdAt), asc(users.email));
  return {
    id: workspace.id,
    name: workspace.name,
    plan: entitlements.plan,
    source: entitlements.source,
    suspendedAt: workspace.suspendedAt,
    suspendedReason: workspace.suspendedReason,
    override: subscription?.planOverride
      ? {
          plan: subscription.planOverride,
          until: subscription.planOverrideUntil,
          reason: subscription.planOverrideReason,
          active: entitlements.source === "override",
        }
      : null,
    members: memberRows.map((m) => ({ userId: m.userId, email: m.email, role: m.role, status: m.status, twoFactor: Boolean(m.confirmedAt) })),
  };
}
