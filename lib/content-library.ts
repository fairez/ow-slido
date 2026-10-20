import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { interactionModule } from "@/lib/interaction-modules";
import { publish } from "@/lib/realtime/publisher";

/** Host sockets of the event refetch the content list when they hear this. */
export const CONTENT_CHANGED = "content:changed";

export function publishContentChanged(eventId: string) {
  publish(eventId, CONTENT_CHANGED, {}, { hostOnly: true });
}

/**
 * Responses per interaction of an event, for the content list; each type's module decides what
 * counts (rejected notes and questions are left out).
 */
export async function responseCounts(eventId: string): Promise<Record<string, number>> {
  const list = await getDb().select({ id: interactions.id, type: interactions.type }).from(interactions).where(eq(interactions.eventId, eventId));
  const counts = await Promise.all(list.map((i) => interactionModule(i.type).responseCount(i.id)));
  return Object.fromEntries(list.flatMap((i, n) => (counts[n] > 0 ? [[i.id, counts[n]]] : [])));
}
