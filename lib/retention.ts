import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { events, memberships, users, workspaces } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { getEmailSender } from "@/lib/email";
import { DEFAULT_LOCALE, t } from "@/lib/i18n";

type Db = ReturnType<typeof getDb>;

export const RETENTION_OPTIONS = [30, 90, 365] as const;
export type RetentionDays = (typeof RETENTION_OPTIONS)[number];

/** How long before an automatic delete the owners and admins are warned. */
export const RETENTION_NOTICE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseRetentionDays(value: unknown): { ok: true; value: RetentionDays | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value === "number" && (RETENTION_OPTIONS as readonly number[]).includes(value)) {
    return { ok: true, value: value as RetentionDays };
  }
  return { ok: false };
}

/**
 * Stores the retention period and forgets the warnings already sent: they named a date that no longer holds,
 * and a shorter period must warn again before anything is deleted.
 * Returns the previous value, or `undefined` when the workspace does not exist.
 */
export async function setRetentionDays(
  db: Db,
  workspaceId: string,
  retentionDays: RetentionDays | null,
): Promise<{ from: number | null } | undefined> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ retentionDays: workspaces.retentionDays })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update");
    if (!before) return undefined;
    if (before.retentionDays !== retentionDays) {
      await tx.update(workspaces).set({ retentionDays }).where(eq(workspaces.id, workspaceId));
      await tx.update(events).set({ deletionNoticeSentAt: null }).where(eq(events.workspaceId, workspaceId));
    }
    return { from: before.retentionDays };
  });
}

export type RetentionResult = { warned: number; deleted: number };

/**
 * One pass of the retention job. For every workspace with a period set:
 * - events that end within the next 7 days of their delete date get one warning email (owners and admins);
 * - events past the period are deleted, with all their data, once a warning is at least 7 days old.
 *   An event that was never warned (retention turned on late, job down) is warned first and goes later.
 * Takes `now` so tests use fixed dates.
 */
export async function runRetention(db: Db = getDb(), now: Date = new Date()): Promise<RetentionResult> {
  const result: RetentionResult = { warned: 0, deleted: 0 };
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name, retentionDays: workspaces.retentionDays })
    .from(workspaces)
    .where(isNotNull(workspaces.retentionDays));

  for (const workspace of rows) {
    const days = workspace.retentionDays as number;
    // ends_at + days <= now  <=>  ends_at <= now - days
    const dueBefore = new Date(now.getTime() - days * DAY_MS);
    const warnBefore = new Date(now.getTime() - (days - RETENTION_NOTICE_DAYS) * DAY_MS);
    const noticeOldEnough = new Date(now.getTime() - RETENTION_NOTICE_DAYS * DAY_MS);

    const doomed = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, workspace.id),
          lte(events.endsAt, dueBefore),
          isNotNull(events.deletionNoticeSentAt),
          lte(events.deletionNoticeSentAt, noticeOldEnough),
        ),
      );
    for (const event of doomed) {
      const removed = await db.delete(events).where(eq(events.id, event.id)).returning({ id: events.id });
      if (removed.length === 0) continue;
      result.deleted += 1;
      // Ids and the period only: the event's name and content are gone with it.
      await recordAudit(undefined, {
        workspaceId: workspace.id,
        actorLabel: "system",
        action: "event.retention_deleted",
        targetType: "event",
        targetId: event.id,
        metadata: { retentionDays: days },
      });
    }

    const pending = await db
      .select({ id: events.id, name: events.name, endsAt: events.endsAt })
      .from(events)
      .where(and(eq(events.workspaceId, workspace.id), lte(events.endsAt, warnBefore), isNull(events.deletionNoticeSentAt)));
    if (pending.length === 0) continue;

    const recipients = await db
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.workspaceId, workspace.id),
          eq(memberships.status, "active"),
          inArray(memberships.role, ["owner", "admin"]),
        ),
      );
    for (const event of pending) {
      // The date is the later of the period's end and a full notice period from today.
      const deleteOn = new Date(Math.max(event.endsAt.getTime() + days * DAY_MS, now.getTime() + RETENTION_NOTICE_DAYS * DAY_MS));
      const sent = await sendNotices(recipients.map((r) => r.email), {
        event: event.name,
        workspace: workspace.name,
        date: deleteOn.toISOString().slice(0, 10),
      });
      // Nobody reachable: try again on the next run rather than delete without a warning.
      if (recipients.length > 0 && sent === 0) continue;
      const marked = await db
        .update(events)
        .set({ deletionNoticeSentAt: now })
        .where(and(eq(events.id, event.id), isNull(events.deletionNoticeSentAt)))
        .returning({ id: events.id });
      if (marked.length > 0) result.warned += 1;
    }
  }
  return result;
}

async function sendNotices(to: string[], params: { event: string; workspace: string; date: string }): Promise<number> {
  let sent = 0;
  for (const address of to) {
    try {
      await getEmailSender().send({
        to: address,
        subject: t(DEFAULT_LOCALE, "email.retention.subject", params),
        text: t(DEFAULT_LOCALE, "email.retention.body", params),
      });
      sent += 1;
    } catch {
      // One bad address must not stop the others.
    }
  }
  return sent;
}

const SWEEP_INTERVAL_MS = DAY_MS;

/** Runs `runRetention` now and then once a day. The timer does not keep the process alive. */
export function startRetentionSweep(db: Db = getDb()): () => void {
  const run = () =>
    runRetention(db).catch((error) =>
      console.error("> retention sweep failed:", error instanceof Error ? error.message : error),
    );
  void run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
