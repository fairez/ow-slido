import { and, count, desc, eq, gte, ilike, lt, type SQL } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { auditLog } from "@/db/schema";

type Db = ReturnType<typeof createDb>["db"];

export const AUDIT_PAGE_SIZE = 50;

export type AuditFilters = {
  /** Exact action name such as `member.removed`. */
  action?: string;
  /** Part of the actor label (an email, `system`, `operator:<email>`), any case. */
  actor?: string;
  /** Inclusive start instant. */
  from?: Date;
  /** Exclusive end instant. */
  to?: Date;
  /** 1-based. */
  page?: number;
};

export type AuditRow = {
  id: string;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: Date;
};

export type AuditPage = { entries: AuditRow[]; total: number; page: number; pageSize: number };

/** Parses the query string of the audit API; `error` names the parameter that was not usable. */
export function parseAuditFilters(params: URLSearchParams): { ok: true; value: AuditFilters } | { ok: false; error: "from" | "to" | "page" } {
  const value: AuditFilters = {};
  const action = params.get("action")?.trim();
  if (action) value.action = action.slice(0, 80);
  const actor = params.get("actor")?.trim();
  if (actor) value.actor = actor.slice(0, 200);
  for (const key of ["from", "to"] as const) {
    const raw = params.get(key);
    if (!raw) continue;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return { ok: false, error: key };
    value[key] = date;
  }
  const rawPage = params.get("page");
  if (rawPage) {
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1 || page > 100_000) return { ok: false, error: "page" };
    value.page = page;
  }
  return { ok: true, value };
}

export function escapeLike(text: string) {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Entries of one workspace, newest first, `AUDIT_PAGE_SIZE` at a time. */
export async function listAuditEntries(db: Db, workspaceId: string, filters: AuditFilters = {}): Promise<AuditPage> {
  const page = filters.page ?? 1;
  const conditions: SQL[] = [eq(auditLog.workspaceId, workspaceId)];
  if (filters.action) conditions.push(eq(auditLog.action, filters.action));
  if (filters.actor) conditions.push(ilike(auditLog.actorLabel, `%${escapeLike(filters.actor)}%`));
  if (filters.from) conditions.push(gte(auditLog.createdAt, filters.from));
  if (filters.to) conditions.push(lt(auditLog.createdAt, filters.to));
  const where = and(...conditions);

  const [entries, [{ total }]] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        actorLabel: auditLog.actorLabel,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        metadata: auditLog.metadata,
        ip: auditLog.ip,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(AUDIT_PAGE_SIZE)
      .offset((page - 1) * AUDIT_PAGE_SIZE),
    db.select({ total: count() }).from(auditLog).where(where),
  ]);
  return { entries, total, page, pageSize: AUDIT_PAGE_SIZE };
}

/** Action names the workspace has entries for, to fill the filter list. */
export async function listAuditActions(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ action: auditLog.action }).from(auditLog).where(eq(auditLog.workspaceId, workspaceId)).orderBy(auditLog.action);
  return rows.map((row) => row.action);
}
