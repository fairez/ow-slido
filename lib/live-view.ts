import { and, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { pollConfig, type PollConfig, type PollOption } from "@/lib/polls";

/** What a participant may see of the live interaction; host-only settings are left out. */
export type LiveInteraction = {
  id: string;
  type: "poll";
  title: string;
  state: "live" | "closed";
  options: PollOption[];
  multiSelect: boolean;
};

export async function getLiveInteraction(eventId: string): Promise<LiveInteraction | null> {
  const [row] = await getDb()
    .select()
    .from(interactions)
    .where(and(eq(interactions.eventId, eventId), eq(interactions.state, "live")));
  if (!row || row.type !== "poll") return null;
  const config = pollConfig(row.config as Partial<PollConfig>);
  return {
    id: row.id,
    type: "poll",
    title: row.title,
    state: "live",
    options: config.options,
    multiSelect: config.multiSelect,
  };
}
