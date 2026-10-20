import { and, inArray, ne } from "drizzle-orm";
import { subscriptions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { resolveEntitlements } from "@/lib/plans";
import { reconcileSeats } from "@/lib/seats";

type Db = ReturnType<typeof getDb>;

/**
 * Writes `plan: free` for subscriptions whose paid access has ended (grace over, or a canceled period past
 * its end). `getEntitlements` already answers Free for them from the stored dates, so this only keeps the
 * stored rows honest for anything that reads the table directly. Overrides are left as they are.
 * Returns the workspaces that changed.
 */
export async function expireSubscriptions(db: Db = getDb(), now: Date = new Date()): Promise<string[]> {
  const candidates = await db
    .select()
    .from(subscriptions)
    .where(and(ne(subscriptions.plan, "free"), inArray(subscriptions.status, ["past_due", "canceled"])));
  const lapsed = candidates.filter((row) => resolveEntitlements({ ...row, planOverride: null }, now).plan === "free");
  if (lapsed.length === 0) return [];

  const rows = await db
    .update(subscriptions)
    .set({ plan: "free", updatedAt: now })
    .where(
      and(
        inArray(
          subscriptions.id,
          lapsed.map((row) => row.id),
        ),
        // A webhook may have restored the subscription since the read above.
        inArray(subscriptions.status, ["past_due", "canceled"]),
      ),
    )
    .returning({ workspaceId: subscriptions.workspaceId });
  return rows.map((row) => row.workspaceId);
}

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Runs `expireSubscriptions` now and then once a day. The timer does not keep the process alive. */
export function startSubscriptionSweep(db: Db = getDb()): () => void {
  const run = () =>
    expireSubscriptions(db)
      .then((lapsed) => Promise.all(lapsed.map((workspaceId) => reconcileSeats(workspaceId, { db }))))
      .catch((error) => console.error("> subscription sweep failed:", error instanceof Error ? error.message : error));
  void run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
