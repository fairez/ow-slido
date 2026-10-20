import { and, eq, sql } from "drizzle-orm";
import { participants } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { PlanLimitError, assertParticipantSlot } from "@/lib/limits";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";

type EventRef = { id: string; workspaceId: string };

export type EnsureParticipant = { ok: true; participantId: string } | { ok: false; limit: PlanLimitError };

/** The participant named by the request's cookie token for this event, or null. */
export async function existingParticipantId(request: Request, eventId: string): Promise<string | null> {
  const token = readParticipantToken(request, eventId);
  const tokenParticipantId = token ? verifyParticipantToken(token, eventId) : null;
  if (!tokenParticipantId || !isUuid(tokenParticipantId)) return null;
  const [existing] = await getDb()
    .select({ id: participants.id })
    .from(participants)
    .where(and(eq(participants.id, tokenParticipantId), eq(participants.eventId, eventId)));
  return existing?.id ?? null;
}

/** Reuses the participant from the cookie token, else creates one under the plan's participant limit. */
export async function ensureParticipant(request: Request, event: EventRef): Promise<EnsureParticipant> {
  const existing = await existingParticipantId(request, event.id);
  if (existing) return { ok: true, participantId: existing };
  try {
    const participantId = await getDb().transaction(async (tx) => {
      // One lock per event, so two joins cannot both take the last slot.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${event.id}))`);
      await assertParticipantSlot(event.workspaceId, event.id, tx);
      const [created] = await tx.insert(participants).values({ eventId: event.id }).returning({ id: participants.id });
      return created.id;
    });
    return { ok: true, participantId };
  } catch (error) {
    if (error instanceof PlanLimitError) return { ok: false, limit: error };
    throw error;
  }
}
