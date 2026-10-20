import { sql } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { publish } from "@/lib/realtime/publisher";

/** Host sockets of the event refetch the content list when they hear this. */
export const CONTENT_CHANGED = "content:changed";

export function publishContentChanged(eventId: string) {
  publish(eventId, CONTENT_CHANGED, {}, { hostOnly: true });
}

/**
 * Responses per interaction of an event, for the content list: poll votes, word entries, notes,
 * open text answers, ratings and questions. Rejected notes and questions are left out.
 */
export async function responseCounts(eventId: string): Promise<Record<string, number>> {
  const mine = sql`(select ${interactions.id} from ${interactions} where ${interactions.eventId} = ${eventId})`;
  const result = await getDb().execute<{ id: string; n: number }>(sql`
    select interaction_id as id, count(*)::int as n from (
      select interaction_id from poll_votes where interaction_id in ${mine}
      union all select interaction_id from wordcloud_entries where interaction_id in ${mine}
      union all select interaction_id from open_text_responses where interaction_id in ${mine}
      union all select interaction_id from rating_responses where interaction_id in ${mine}
      union all select interaction_id from shared_notes where status <> 'rejected' and interaction_id in ${mine}
      union all select interaction_id from questions where status <> 'rejected' and interaction_id in ${mine}
    ) r group by interaction_id
  `);
  return Object.fromEntries(result.rows.map((row) => [row.id, row.n]));
}
