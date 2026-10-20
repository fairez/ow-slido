import { and, eq, inArray, sql } from "drizzle-orm";
import { interactions, participants } from "@/db/schema";
import { getDb } from "@/lib/db";
import { getLeaderboardStore } from "@/lib/leaderboard";
import { publishContentChanged } from "@/lib/content-library";
import { publish } from "@/lib/realtime/publisher";

/**
 * Every table that stores something a participant contributed, with an SQL expression for the interaction
 * it belongs to (a vote reaches it through its question or note). They all cascade from `participants`, so
 * deleting the participant row clears them; the list drives the contribution count and tells which
 * screens need a refresh. tests/participant-data.test.ts fails when a table gains a `participant_id`
 * column and is missing here.
 */
const CONTRIBUTIONS = [
  { table: "poll_votes", interaction: "interaction_id" },
  { table: "wordcloud_entries", interaction: "interaction_id" },
  { table: "questions", interaction: "interaction_id" },
  { table: "question_votes", interaction: "(select q.interaction_id from questions q where q.id = question_id)" },
  { table: "shared_notes", interaction: "interaction_id" },
  { table: "shared_note_votes", interaction: "(select n.interaction_id from shared_notes n where n.id = note_id)" },
  { table: "open_text_responses", interaction: "interaction_id" },
  { table: "rating_responses", interaction: "interaction_id" },
  { table: "ranking_responses", interaction: "interaction_id" },
  { table: "quiz_answers", interaction: "interaction_id" },
  { table: "survey_submissions", interaction: "interaction_id" },
] as const;

/** Tables holding participant-linked data that are not a countable contribution (the running quiz total). */
export const PARTICIPANT_DATA_OTHER_TABLES = ["quiz_scores"] as const;

export const PARTICIPANT_DATA_TABLES: readonly string[] = [
  ...CONTRIBUTIONS.map((c) => c.table),
  ...PARTICIPANT_DATA_OTHER_TABLES,
];

export const PARTICIPANT_LIST_LIMIT = 200;

export type ParticipantSummary = {
  id: string;
  /** Quiz nickname, else the name used on a question or note; null for a fully anonymous participant. */
  name: string | null;
  joinedAt: Date;
  contributions: number;
};

const eventParticipants = (eventId: string) => sql`select id from participants where event_id = ${eventId}`;

/** The event's participants, earliest first, with how much each contributed. */
export async function listParticipants(eventId: string): Promise<{ participants: ParticipantSummary[]; total: number }> {
  const db = getDb();
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(participants)
    .where(eq(participants.eventId, eventId));
  const branches = sql.join(
    CONTRIBUTIONS.map((c) => sql`select participant_id from ${sql.raw(c.table)} where participant_id in (${eventParticipants(eventId)})`),
    sql` union all `,
  );
  const { rows } = await db.execute<{ id: string; name: string | null; joined_at: Date; contributions: number }>(sql`
    select p.id, p.joined_at, coalesce(c.n, 0)::int as contributions,
      coalesce(
        p.nickname,
        (select q.author_name from questions q where q.participant_id = p.id and q.author_name is not null order by q.created_at desc limit 1),
        (select n.author_name from shared_notes n where n.participant_id = p.id and n.author_name is not null order by n.created_at desc limit 1)
      ) as name
    from participants p
    left join (select participant_id, count(*) as n from (${branches}) u group by participant_id) c on c.participant_id = p.id
    where p.event_id = ${eventId}
    order by p.joined_at asc, p.id asc
    limit ${PARTICIPANT_LIST_LIMIT}
  `);
  return {
    total: count,
    participants: rows.map((r) => ({ id: r.id, name: r.name, joinedAt: new Date(r.joined_at), contributions: r.contributions })),
  };
}

/**
 * Erases one participant from an event: the participant row goes, and every table above follows by
 * cascade (responses, votes they cast, their notes and questions with the votes on those, quiz answers
 * and score, survey submission). Nothing is anonymised and kept. Results are computed from rows, so
 * counts follow; the live leaderboard and open screens are told afterwards.
 * Returns null when the participant is not in this event.
 */
export async function deleteParticipantData(eventId: string, participantId: string): Promise<{ removed: number } | null> {
  const db = getDb();
  const outcome = await db.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: participants.id })
      .from(participants)
      .where(and(eq(participants.id, participantId), eq(participants.eventId, eventId)))
      .for("update");
    if (!found) return null;
    const branches = sql.join(
      CONTRIBUTIONS.map(
        (c) => sql`select ${sql.raw(c.interaction)} as interaction_id from ${sql.raw(c.table)} where participant_id = ${participantId}`,
      ),
      sql` union all `,
    );
    const { rows } = await tx.execute<{ interaction_id: string }>(sql`select interaction_id from (${branches}) u`);
    await tx.delete(participants).where(eq(participants.id, participantId));
    return { removed: rows.length, interactionIds: [...new Set(rows.map((r) => r.interaction_id))] };
  });
  if (!outcome) return null;

  await getLeaderboardStore().remove(eventId, participantId);
  if (outcome.interactionIds.length > 0) {
    const touched = await db
      .select({ interactionId: interactions.id, state: interactions.state })
      .from(interactions)
      .where(inArray(interactions.id, outcome.interactionIds));
    for (const change of touched) publish(eventId, "state-changed", change);
  }
  publishContentChanged(eventId);
  return { removed: outcome.removed };
}
