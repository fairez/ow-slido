import { and, eq } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { auditLog, memberships } from "@/db/schema";
import { getDb } from "@/lib/db";
import { clientIp } from "@/lib/rate-limit";

/** Inserts only, so a transaction works as well as the pool. */
type Db = Pick<ReturnType<typeof createDb>["db"], "insert">;

export type AuditEntry = {
  /** Null for platform-level entries that belong to no workspace. */
  workspaceId: string | null;
  actorUserId?: string | null;
  /** Who it was, kept even after the account is gone (an email, "system", "operator:<email>"). */
  actorLabel: string;
  /** Dotted name such as `member.role_changed`. */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Small facts about the action. Never request bodies, note text or secrets. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
};

/** Keys whose value is never stored, matched case-insensitively as a part of the key name (`apiKey`, `newPassword`). */
export const AUDIT_DENY_KEYS = ["password", "token", "secret", "key", "text", "note"];

const REDACTED_DEPTH = 5;

function denied(key: string) {
  const lower = key.toLowerCase();
  return AUDIT_DENY_KEYS.some((word) => lower.includes(word));
}

/** Copy of `value` without any denied key, at every depth. Anything that is not plain JSON is dropped. */
export function stripAuditMetadata(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= REDACTED_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((item) => stripAuditMetadata(item, depth + 1) ?? null);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (denied(key)) continue;
      const clean = stripAuditMetadata(inner, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return undefined;
}

/**
 * The only writer of `audit_log`. A failed write is logged without any entry content and never thrown,
 * so a sensitive action does not fail because its record could not be kept.
 * Returns whether the entry was stored.
 */
export async function recordAudit(db: Db | undefined, entry: AuditEntry) {
  try {
    const metadata = stripAuditMetadata(entry.metadata ?? {}) as Record<string, unknown>;
    await (db ?? getDb()).insert(auditLog).values({
      workspaceId: entry.workspaceId,
      actorUserId: entry.actorUserId ?? null,
      actorLabel: entry.actorLabel,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata,
      ip: entry.ip ?? null,
    });
    return true;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    console.error("> audit write failed:", entry.action, code ?? (error instanceof Error ? error.name : "error"));
    return false;
  }
}

type Actor = { id: string; email: string };

/** Who and from where, for entries about something a signed-in person did through a route. */
export function auditContext(request: Request, actor: Actor) {
  return { actorUserId: actor.id, actorLabel: actor.email, ip: clientIp(request) };
}

/**
 * For account-level events (login, password, 2FA) that belong to no single workspace: one entry in every
 * workspace the person is an active member of, so each owner sees it. A person without a workspace gets none.
 */
export async function recordAuditForUser(
  request: Request,
  actor: Actor,
  entry: Pick<AuditEntry, "action" | "metadata">,
  db: Pick<ReturnType<typeof createDb>["db"], "insert" | "select"> = getDb(),
) {
  try {
    const rows = await db
      .select({ workspaceId: memberships.workspaceId })
      .from(memberships)
      .where(and(eq(memberships.userId, actor.id), eq(memberships.status, "active")));
    for (const { workspaceId } of rows) {
      await recordAudit(db, {
        ...entry,
        ...auditContext(request, actor),
        workspaceId,
        targetType: "user",
        targetId: actor.id,
      });
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    console.error("> audit write failed:", entry.action, code ?? (error instanceof Error ? error.name : "error"));
  }
}
