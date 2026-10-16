import { and, eq, gte, sql } from "drizzle-orm";
import { aiCalls } from "@/db/schema";
import { getDb } from "@/lib/db";
import { getAiConfig } from "./config";
import { AiError } from "./types";

// Serialises cap checks so concurrent calls cannot both squeeze under the limit.
const LOCK_KEY = 7_361_001;

function startOfUtcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Counts one call against the caps and records it, or throws if a cap is already reached. */
export async function reserveAiCall(input: {
  eventId: string | null;
  kind: string;
  provider: string;
  model: string;
  now?: Date;
}) {
  const { eventCallCap, dailyCallCap } = getAiConfig();
  const now = input.now ?? new Date();
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);

    const [{ count: today }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(aiCalls)
      .where(gte(aiCalls.createdAt, startOfUtcDay(now)));
    if (today >= dailyCallCap) {
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
