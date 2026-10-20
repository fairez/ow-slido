import { eq } from "drizzle-orm";
import { events, interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import type { AudienceTarget } from "@/lib/i18n/locale";

/** The event an audience page belongs to, with the language it was set up in; null for an unknown id or code. */
export async function audienceEventFor(target: AudienceTarget): Promise<{ id: string; audienceLocale: string } | null> {
  const db = getDb();
  const pick = { id: events.id, audienceLocale: events.audienceLocale };
  if (target.kind === "join") {
    if (!/^[0-9]{4,6}$/.test(target.key)) return null;
    const [row] = await db.select(pick).from(events).where(eq(events.joinCode, target.key));
    return row ?? null;
  }
  if (!isUuid(target.key)) return null;
  if (target.kind === "survey") {
    const [row] = await db
      .select(pick)
      .from(interactions)
      .innerJoin(events, eq(events.id, interactions.eventId))
      .where(eq(interactions.id, target.key));
    return row ?? null;
  }
  const [row] = await db.select(pick).from(events).where(eq(events.id, target.key));
  return row ?? null;
}
