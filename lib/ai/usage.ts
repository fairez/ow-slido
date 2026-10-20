import { and, eq, gte, lt, sql } from "drizzle-orm";
import { aiCalls } from "@/db/schema";
import { getDb } from "@/lib/db";
import { getAiConfig } from "./config";
import { AiError } from "./types";

type Db = Pick<ReturnType<typeof getDb>, "select">;

// Serialises cap checks so concurrent calls cannot both squeeze under the limit.
const LOCK_KEY = 7_361_001;

function startOfUtcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfNextUtcDay(now: Date) {
  return new Date(startOfUtcDay(now).getTime() + 24 * 60 * 60 * 1000);
}

export class AiPausedError extends Error {
  constructor() {
    super("AI is paused for today");
    this.name = "AiPausedError";
  }
}

/** Every `ai_calls` row of the UTC day, of all workspaces and deleted events. */
export async function countAiCallsToday(db: Db = getDb(), now: Date = new Date()): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiCalls)
    .where(and(gte(aiCalls.createdAt, startOfUtcDay(now)), lt(aiCalls.createdAt, startOfNextUtcDay(now))));
  return count;
}

/**
 * Stops every AI start once the platform-wide daily cap is used up, whatever the workspace's own
 * limits say. Counts all `ai_calls` of the UTC day, including those of deleted events.
 */
export async function assertAiNotPaused(db: Db = getDb(), now: Date = new Date()) {
  const { globalDailyCap } = getAiConfig();
  if ((await countAiCallsToday(db, now)) >= globalDailyCap) throw new AiPausedError();
}

/** Counts one call against the caps and records it, or throws if a cap is already reached. */
export async function reserveAiCall(input: {
  eventId: string | null;
  kind: string;
  provider: string;
  model: string;
  now?: Date;
}) {
  const { eventCallCap, dailyCallCap, globalDailyCap } = getAiConfig();
  const now = input.now ?? new Date();
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);

    const [{ count: today }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(aiCalls)
      .where(gte(aiCalls.createdAt, startOfUtcDay(now)));
    // A call already running when the global cap is reached stops here too.
    if (today >= Math.min(dailyCallCap, globalDailyCap)) {
      throw new AiError("daily_cap", "The daily AI limit has been reached. Try again tomorrow.");
    }

    if (input.eventId) {
      const [{ count: forEvent }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(aiCalls)
        .where(and(eq(aiCalls.eventId, input.eventId)));
      if (forEvent >= eventCallCap) {
        throw new AiError("event_cap", "This event has reached its AI limit.");
      }
    }

    await tx.insert(aiCalls).values({
      eventId: input.eventId,
      kind: input.kind,
      provider: input.provider,
      model: input.model,
      createdAt: now,
    });
  });
}
