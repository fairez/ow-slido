import type { MessageKey, TParams } from "@/lib/i18n";
import { and, eq, inArray, sql } from "drizzle-orm";
import { events, interactions, users } from "@/db/schema";
import { getDb } from "@/lib/db";
import { publish } from "@/lib/realtime/publisher";

export type InteractionRow = typeof interactions.$inferSelect;
export type StateChange = { interactionId: string; state: InteractionRow["state"] };
type Result = { ok: true; interaction: InteractionRow } | { ok: false; error: MessageKey; params?: TParams };

function broadcast(eventId: string, changes: StateChange[]) {
  for (const change of changes) publish(eventId, "state-changed", change);
}

/**
 * Draft or paused -> live. The event's current live interaction is paused (not closed) in the same
 * transaction, so the host can resume it later.
 */
export async function startInteraction(eventId: string, id: string): Promise<Result> {
  const outcome = await getDb().transaction(async (tx) => {
    // Serialize starts per event; locking only the target row lets two different starts race.
    await tx.select({ id: events.id }).from(events).where(eq(events.id, eventId)).for("update");
    const [current] = await tx
      .select({ state: interactions.state })
      .from(interactions)
      .where(and(eq(interactions.id, id), eq(interactions.eventId, eventId)))
      .for("update");
    if (!current || (current.state !== "draft" && current.state !== "paused")) return { current };
    // Pause the old live one first so the one-live-per-event index is never violated.
    const paused = await tx
      .update(interactions)
      .set({ state: "paused" })
      .where(and(eq(interactions.eventId, eventId), eq(interactions.state, "live")))
      .returning({ id: interactions.id });
    const [started] = await tx
      .update(interactions)
      .set({ state: "live" })
      .where(eq(interactions.id, id))
      .returning();
    await tx
      .update(users)
      .set({ firstInteractionLiveAt: sql`coalesce(${users.firstInteractionLiveAt}, now())` })
      .where(eq(users.id, sql`(select ${events.ownerId} from ${events} where ${events.id} = ${eventId})`));
    return { started, paused };
  });

  if (!outcome.started) {
    const state = outcome.current?.state;
    return {
      ok: false,
      error:
        state === "live"
          ? "api.alreadyLive"
          : "api.startInvalid",
    };
  }
  broadcast(eventId, [
    ...outcome.paused.map((c) => ({ interactionId: c.id, state: "paused" as const })),
    { interactionId: id, state: "live" },
  ]);
  return { ok: true, interaction: outcome.started };
}

/** Live -> paused: stops answers without closing; start it again to resume. */
export async function pauseInteraction(eventId: string, id: string): Promise<Result> {
  const [paused] = await getDb()
    .update(interactions)
    .set({ state: "paused" })
    .where(and(eq(interactions.id, id), eq(interactions.eventId, eventId), eq(interactions.state, "live")))
    .returning();
  if (!paused) return { ok: false, error: "api.pauseInvalid" };
  broadcast(eventId, [{ interactionId: id, state: "paused" }]);
  return { ok: true, interaction: paused };
}

/** Live or paused -> closed. */
export async function closeInteraction(eventId: string, id: string): Promise<Result> {
  const [closed] = await getDb()
    .update(interactions)
    .set({ state: "closed" })
    .where(and(eq(interactions.id, id), eq(interactions.eventId, eventId), inArray(interactions.state, ["live", "paused"])))
    .returning();
  if (!closed) return { ok: false, error: "api.closeInvalid" };
  broadcast(eventId, [{ interactionId: id, state: "closed" }]);
  return { ok: true, interaction: closed };
}
