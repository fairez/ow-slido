import { and, eq } from "drizzle-orm";
import { events, interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { publish } from "@/lib/realtime/publisher";

export type InteractionRow = typeof interactions.$inferSelect;
export type StateChange = { interactionId: string; state: InteractionRow["state"] };
type Result = { ok: true; interaction: InteractionRow } | { ok: false; error: string };

function broadcast(eventId: string, changes: StateChange[]) {
  for (const change of changes) publish(eventId, "state-changed", change);
}

/** Draft -> live; the event's current live interaction is closed in the same transaction. */
export async function startInteraction(eventId: string, id: string): Promise<Result> {
  const outcome = await getDb().transaction(async (tx) => {
    // Serialize starts per event; locking only the target row lets two different starts race.
    await tx.select({ id: events.id }).from(events).where(eq(events.id, eventId)).for("update");
    const [current] = await tx
      .select({ state: interactions.state })
      .from(interactions)
      .where(and(eq(interactions.id, id), eq(interactions.eventId, eventId)))
      .for("update");
    if (!current || current.state !== "draft") return { current };
    // Close the old live one first so the one-live-per-event index is never violated.
    const closed = await tx
      .update(interactions)
      .set({ state: "closed" })
      .where(and(eq(interactions.eventId, eventId), eq(interactions.state, "live")))
      .returning({ id: interactions.id });
    const [started] = await tx
      .update(interactions)
      .set({ state: "live" })
      .where(eq(interactions.id, id))
      .returning();
    return { started, closed };
  });

  if (!outcome.started) {
    const state = outcome.current?.state;
    return {
      ok: false,
      error:
        state === "live"
          ? "Interaction is already live"
          : "Only draft interactions can be started; duplicate a closed one to run it again",
    };
  }
  broadcast(eventId, [
    ...outcome.closed.map((c) => ({ interactionId: c.id, state: "closed" as const })),
    { interactionId: id, state: "live" },
  ]);
  return { ok: true, interaction: outcome.started };
}

/** Live -> closed. */
export async function closeInteraction(eventId: string, id: string): Promise<Result> {
  const [closed] = await getDb()
    .update(interactions)
    .set({ state: "closed" })
    .where(and(eq(interactions.id, id), eq(interactions.eventId, eventId), eq(interactions.state, "live")))
    .returning();
  if (!closed) return { ok: false, error: "Only a live interaction can be closed" };
  broadcast(eventId, [{ interactionId: id, state: "closed" }]);
  return { ok: true, interaction: closed };
}
