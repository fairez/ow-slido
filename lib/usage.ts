import { and, count, eq, gte, lt, max } from "drizzle-orm";
import { aiCalls, events, participants } from "@/db/schema";
import { getDb } from "@/lib/db";
import { seatsInUse } from "@/lib/seats";
import { utcMonthBounds } from "@/lib/plans";

type Db = Pick<ReturnType<typeof getDb>, "select">;

export type WorkspaceUsage = {
  seats: number;
  eventsThisMonth: number;
  /** Largest audience of any event created this UTC month; the plan caps one event at a time. */
  participantsPeak: number;
  aiCallsThisMonth: number;
  /** Megabytes of uploaded images. Nothing uploads images yet, so this stays 0 until image storage ships. */
  storageMb: number;
};

/** What the plan page measures against the limits. Months follow `utcMonthBounds`, like the limit checks. */
export async function getUsage(workspaceId: string, options: { db?: Db; now?: Date } = {}): Promise<WorkspaceUsage> {
  const db = options.db ?? getDb();
  const { start, end } = utcMonthBounds(options.now);
  const inMonth = and(eq(events.workspaceId, workspaceId), gte(events.createdAt, start), lt(events.createdAt, end));

  const [{ eventsThisMonth }] = await db.select({ eventsThisMonth: count() }).from(events).where(inMonth);

  const perEvent = db
    .select({ n: count().as("n") })
    .from(participants)
    .innerJoin(events, eq(events.id, participants.eventId))
    .where(inMonth)
    .groupBy(participants.eventId)
    .as("per_event");
  const [{ peak }] = await db.select({ peak: max(perEvent.n) }).from(perEvent);

  const [{ aiCallsThisMonth }] = await db
    .select({ aiCallsThisMonth: count() })
    .from(aiCalls)
    .innerJoin(events, eq(events.id, aiCalls.eventId))
    .where(and(eq(events.workspaceId, workspaceId), gte(aiCalls.createdAt, start), lt(aiCalls.createdAt, end)));

  return {
    seats: await seatsInUse(workspaceId, { db }),
    eventsThisMonth,
    participantsPeak: Number(peak ?? 0),
    aiCallsThisMonth,
    storageMb: 0,
  };
}

