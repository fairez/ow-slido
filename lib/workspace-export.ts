import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { events, memberships, templateItems, templates, users, workspaceExports } from "@/db/schema";
import { buildEventFiles, csvField, fileSlug } from "@/lib/export";
import { getDb } from "@/lib/db";
import { runWithRetry } from "@/lib/jobs";
import { getEntitlements } from "@/lib/plans";
import { createZip, type ZipEntry } from "@/lib/zip";

/** How long a finished export can be downloaded. */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a download link works; the status endpoint hands out a new one on every call. */
export const DOWNLOAD_LINK_TTL_MS = 5 * 60 * 1000;
/** A running export older than this is marked failed by the sweep. */
export const STUCK_AFTER_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type WorkspaceExportStatus = (typeof workspaceExports.$inferSelect)["status"];

/** Everything about an export except the file itself. */
const statusColumns = {
  id: workspaceExports.id,
  workspaceId: workspaceExports.workspaceId,
  status: workspaceExports.status,
  error: workspaceExports.error,
  sizeBytes: workspaceExports.sizeBytes,
  createdAt: workspaceExports.createdAt,
  startedAt: workspaceExports.startedAt,
  finishedAt: workspaceExports.finishedAt,
  expiresAt: workspaceExports.expiresAt,
};

export async function getWorkspaceExport(id: string, workspaceId: string) {
  const [row] = await getDb()
    .select(statusColumns)
    .from(workspaceExports)
    .where(and(eq(workspaceExports.id, id), eq(workspaceExports.workspaceId, workspaceId)));
  return row ?? null;
}

function isUniqueViolation(error: unknown) {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "23505" || code?.cause?.code === "23505";
}

/** Queues an export. A workspace with one queued or running gets `running` and that export's id instead. */
export async function requestWorkspaceExport(input: { workspaceId: string; userId: string | null }) {
  const db = getDb();
  try {
    const [row] = await db
      .insert(workspaceExports)
      .values({ workspaceId: input.workspaceId, requestedBy: input.userId })
      .returning({ id: workspaceExports.id });
    return { ok: true as const, exportId: row.id };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const [active] = await db
      .select({ id: workspaceExports.id })
      .from(workspaceExports)
      .where(and(eq(workspaceExports.workspaceId, input.workspaceId), inArray(workspaceExports.status, ["queued", "running"])));
    if (!active) throw error;
    return { ok: false as const, reason: "running" as const, exportId: active.id };
  }
}

function csv(rows: (string | number)[][]) {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/**
 * The workspace as one ZIP: per event a folder with `event.json` and the per-interaction CSVs from each type's
 * module, `templates.json`, `members.csv` (email and role only) and `plan.json`. No participant ids, tokens or
 * IPs, no password hashes and no audit entries: only what the CSV modules already publish plus the files above.
 */
export async function buildWorkspaceZip(workspaceId: string, now: Date = new Date()) {
  const db = getDb();
  const entries: ZipEntry[] = [];

  const eventRows = await db
    .select()
    .from(events)
    .where(eq(events.workspaceId, workspaceId))
    .orderBy(asc(events.createdAt), asc(events.id));
  const width = Math.max(2, String(eventRows.length).length);
  for (const [i, event] of eventRows.entries()) {
    const folder = `events/${String(i + 1).padStart(width, "0")}-${fileSlug(event.name) || "event"}`;
    entries.push({
      name: `${folder}/event.json`,
      data: json({ name: event.name, startsAt: event.startsAt, endsAt: event.endsAt, joinCode: event.joinCode, createdAt: event.createdAt }),
    });
    for (const file of await buildEventFiles(event.id)) entries.push({ name: `${folder}/${file.name}`, data: file.data });
  }

  const templateRows = await db.select().from(templates).where(eq(templates.workspaceId, workspaceId)).orderBy(asc(templates.createdAt), asc(templates.id));
  const items = templateRows.length
    ? await db.select().from(templateItems).where(inArray(templateItems.templateId, templateRows.map((t) => t.id))).orderBy(asc(templateItems.position))
    : [];
  entries.push({
    name: "templates.json",
    data: json(
      templateRows.map((t) => ({
        name: t.name,
        kind: t.kind,
        createdAt: t.createdAt,
        items: items.filter((item) => item.templateId === t.id).map((item) => ({ type: item.type, title: item.title, config: item.config })),
      })),
    ),
  });

  const memberRows = await db
    .select({ email: users.email, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(asc(memberships.createdAt), asc(users.email));
  entries.push({ name: "members.csv", data: csv([["email", "role"], ...memberRows.map((m) => [m.email, m.role])]) });

  const plan = await getEntitlements(workspaceId, { now });
  entries.push({
    name: "plan.json",
    data: json({ plan: plan.plan, status: plan.status, interval: plan.interval, currentPeriodEnd: plan.currentPeriodEnd, exportedAt: now }),
  });

  return createZip(entries, now);
}

type RunOptions = {
  now?: Date;
  build?: (workspaceId: string, now: Date) => Promise<Buffer>;
  /** Waits between tries and how to wait; tests pass zeros. */
  delays?: number[];
  sleep?: (ms: number) => Promise<void>;
};

/** Runs a queued export to the end, retrying a failed build with backoff. Never throws: a failure is recorded as `failed` with a short code and error class. */
export async function runWorkspaceExport(exportId: string, options: RunOptions = {}) {
  const db = getDb();
  const now = options.now ?? new Date();
  const [claimed] = await db
    .update(workspaceExports)
    .set({ status: "running", startedAt: now })
    .where(and(eq(workspaceExports.id, exportId), eq(workspaceExports.status, "queued")))
    .returning({ workspaceId: workspaceExports.workspaceId });
  if (!claimed) return;

  const result = await runWithRetry(() => (options.build ?? buildWorkspaceZip)(claimed.workspaceId, now), {
    delays: options.delays,
    sleep: options.sleep,
    onAttempt: (attempts) => db.update(workspaceExports).set({ attempts }).where(eq(workspaceExports.id, exportId)).then(() => undefined),
  });
  if (result.ok) {
    const zip = result.value;
    await db
      .update(workspaceExports)
      .set({ status: "done", zip, sizeBytes: zip.length, errorClass: null, finishedAt: now, expiresAt: new Date(now.getTime() + EXPORT_TTL_MS) })
      .where(eq(workspaceExports.id, exportId));
    return;
  }
  // The message may quote content, so only the class is stored and logged.
  console.error("> workspace export failed:", result.errorClass);
  await db
    .update(workspaceExports)
    .set({ status: "failed", error: "build_failed", errorClass: result.errorClass, zip: null, finishedAt: now })
    .where(eq(workspaceExports.id, exportId));
}

/** Starts the job after the response is on its way; the request never waits for the build. */
export function scheduleWorkspaceExport(exportId: string) {
  setImmediate(() => void runWorkspaceExport(exportId));
}

/** Removes files past their 24 hours and fails running exports that never finished. */
export async function sweepWorkspaceExports(now: Date = new Date()) {
  const db = getDb();
  await db
    .update(workspaceExports)
    .set({ status: "expired", zip: null })
    .where(and(eq(workspaceExports.status, "done"), lt(workspaceExports.expiresAt, now)));
  await db
    .update(workspaceExports)
    .set({ status: "failed", error: "timeout", finishedAt: now })
    .where(and(eq(workspaceExports.status, "running"), lt(workspaceExports.startedAt, new Date(now.getTime() - STUCK_AFTER_MS))));
}

/** Jobs run inside the server process, so any queued or running row found at start belongs to a process that is gone. */
export async function failInterruptedWorkspaceExports(now: Date = new Date()) {
  await getDb()
    .update(workspaceExports)
    .set({ status: "failed", error: "interrupted", finishedAt: now })
    .where(inArray(workspaceExports.status, ["queued", "running"]));
}

/** Clears what a dead process left and then sweeps hourly. The timer does not keep the process alive. */
export function startWorkspaceExportSweep(): () => void {
  const report = (error: unknown) => console.error("> export sweep failed:", error instanceof Error ? error.message : error);
  void failInterruptedWorkspaceExports().then(() => sweepWorkspaceExports()).catch(report);
  const timer = setInterval(() => void sweepWorkspaceExports().catch(report), SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function linkSignature(exportId: string, expires: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(`workspace-export:${exportId}:${expires}`).digest("base64url");
}

/** A path with an expiry and a signature for this export alone. */
export function signDownloadLink(exportId: string, now: Date = new Date()) {
  const expires = String(now.getTime() + DOWNLOAD_LINK_TTL_MS);
  return `/api/workspace/export/${exportId}/download?expires=${expires}&sig=${linkSignature(exportId, expires)}`;
}

export function verifyDownloadLink(exportId: string, expires: string | null, sig: string | null, now: Date = new Date()) {
  if (!expires || !sig || !/^\d+$/.test(expires) || Number(expires) < now.getTime()) return false;
  const expected = Buffer.from(linkSignature(exportId, expires));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The stored file, or null when it is gone. */
export async function readWorkspaceExportFile(id: string, workspaceId: string) {
  const [row] = await getDb()
    .select({ zip: workspaceExports.zip })
    .from(workspaceExports)
    .where(and(eq(workspaceExports.id, id), eq(workspaceExports.workspaceId, workspaceId), eq(workspaceExports.status, "done")));
  return row?.zip ?? null;
}
