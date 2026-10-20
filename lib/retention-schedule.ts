/** Retention constants and the delete-date rule. Client-safe: no database or server imports. */

export const RETENTION_OPTIONS = [30, 90, 365] as const;
export type RetentionDays = (typeof RETENTION_OPTIONS)[number];

/** How long before an automatic delete the owners and admins are warned. */
export const RETENTION_NOTICE_DAYS = 7;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The day the retention job will delete an event, as `runRetention` decides it: the period's end, but never
 * before a full notice period has passed since the warning (sent, or about to be sent now).
 * Null when the workspace keeps everything.
 */
export function deletionDate(params: {
  endsAt: Date;
  retentionDays: number | null;
  noticeSentAt: Date | null;
  now: Date;
}): Date | null {
  if (params.retentionDays === null) return null;
  const periodEnd = params.endsAt.getTime() + params.retentionDays * DAY_MS;
  const warnedAt = params.noticeSentAt ?? params.now;
  return new Date(Math.max(periodEnd, warnedAt.getTime() + RETENTION_NOTICE_DAYS * DAY_MS));
}

/** True when the delete date is within the notice period (or already due). */
export function deletionIsNear(date: Date, now: Date): boolean {
  return date.getTime() - now.getTime() <= RETENTION_NOTICE_DAYS * DAY_MS;
}

/** UTC calendar day, the same form the warning email uses. */
export function formatDeletionDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
