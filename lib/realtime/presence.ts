import { eq, sql } from "drizzle-orm";
import { events } from "@/db/schema";
import { getDb } from "@/lib/db";
import { publish } from "./publisher";

// Connection counts per participant, so several tabs of one participant count once.
// In-memory like the rest of the single-process realtime layer; swap for a shared store if scaled out.
const globalForPresence = globalThis as unknown as { presence?: Map<string, Map<string, number>> };
const presence = (globalForPresence.presence ??= new Map());

export function presenceCount(eventId: string) {
  return presence.get(eventId)?.size ?? 0;
}

function announce(eventId: string) {
  publish(eventId, "presence", { count: presenceCount(eventId) }, { hostOnly: true });
}

export async function participantConnected(eventId: string, participantId: string) {
  const members = presence.get(eventId) ?? new Map<string, number>();
  presence.set(eventId, members);
  members.set(participantId, (members.get(participantId) ?? 0) + 1);
  const count = members.size;
  announce(eventId);
  await getDb()
    .update(events)
    .set({ peakParticipants: sql`greatest(${events.peakParticipants}, ${count})` })
    .where(eq(events.id, eventId));
}

export function participantDisconnected(eventId: string, participantId: string) {
  const members = presence.get(eventId);
  if (!members) return;
  const left = (members.get(participantId) ?? 0) - 1;
  if (left > 0) members.set(participantId, left);
  else members.delete(participantId);
  if (members.size === 0) presence.delete(eventId);
  announce(eventId);
}
