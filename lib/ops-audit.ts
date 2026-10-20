import { count, desc, eq, like } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { auditLog, workspaces } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { AUDIT_PAGE_SIZE } from "@/lib/audit-query";
import { clientIp } from "@/lib/rate-limit";

type Db = ReturnType<typeof createDb>["db"];

/** Every operator action is stored as `operator.<verb>`; the platform view lists exactly these. */
export const OPERATOR_ACTION_PREFIX = "operator.";

/**
 * Writes the entry into the workspace's own log (so its owners see it on Team) under an `operator:<email>` label.
 * The reason an operator typed is kept in metadata, so write reasons a customer may read.
 */
export function recordOperatorAudit(
  request: Request,
  operator: { id: string; email: string },
  entry: { workspaceId: string; verb: string; targetType: string; targetId: string; metadata?: Record<string, unknown> },
) {
  return recordAudit(undefined, {
    workspaceId: entry.workspaceId,
    actorUserId: operator.id,
    actorLabel: `operator:${operator.email}`,
    action: `${OPERATOR_ACTION_PREFIX}${entry.verb}`,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata,
    ip: clientIp(request),
  });
}

export type OperatorActivityRow = {
  id: string;
  workspaceId: string | null;
  workspaceName: string | null;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type OperatorActivityPage = { entries: OperatorActivityRow[]; total: number; page: number; pageSize: number };

/** The platform-level view: operator actions of every workspace, newest first. A deleted workspace takes its entries along. */
export async function listOperatorActivity(db: Db, page = 1): Promise<OperatorActivityPage> {
  const where = like(auditLog.action, `${OPERATOR_ACTION_PREFIX}%`);
  const [entries, [{ total }]] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        workspaceId: auditLog.workspaceId,
        workspaceName: workspaces.name,
        actorLabel: auditLog.actorLabel,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(workspaces, eq(workspaces.id, auditLog.workspaceId))
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(AUDIT_PAGE_SIZE)
      .offset((page - 1) * AUDIT_PAGE_SIZE),
    db.select({ total: count() }).from(auditLog).where(where),
  ]);
  return { entries, total, page, pageSize: AUDIT_PAGE_SIZE };
}
