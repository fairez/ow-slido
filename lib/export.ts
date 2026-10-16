import { and, asc, desc, eq, sql } from "drizzle-orm";
import { interactions, pollVotes, questions, questionVotes } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { PollConfig } from "@/lib/polls";
import { getWordcloudResults } from "@/lib/wordclouds";

export const EXPORT_HEADER = ["section", "title", "item", "count", "author"] as const;

/** Quotes a field for CSV; a leading formula character is neutralised so spreadsheets don't evaluate user text. */
export function csvField(value: string | number) {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One flat table: poll option votes, word counts and approved questions with upvotes.
 * Only aggregates, question text and an optional author name are included, never participant ids.
 */
export async function buildEventCsv(eventId: string) {
  const db = getDb();
  const rows: (string | number)[][] = [[...EXPORT_HEADER]];

  const list = await db
    .select()
    .from(interactions)
    .where(eq(interactions.eventId, eventId))
    .orderBy(asc(interactions.position), asc(interactions.createdAt));

  for (const interaction of list) {
    if (interaction.type === "poll") {
      const votes = await db
        .select({ optionIds: pollVotes.optionIds })
        .from(pollVotes)
        .where(eq(pollVotes.interactionId, interaction.id));
      const tally = new Map<string, number>();
      for (const v of votes) for (const id of v.optionIds) tally.set(id, (tally.get(id) ?? 0) + 1);
      for (const option of (interaction.config as Partial<PollConfig>).options ?? []) {
        rows.push(["poll", interaction.title, option.label, tally.get(option.id) ?? 0, ""]);
      }
    } else {
      const { words } = await getWordcloudResults(interaction.id, db);
      for (const w of words) rows.push(["wordcloud", interaction.title, w.word, w.count, ""]);
    }
  }

  const qs = await db
    .select({ text: questions.text, authorName: questions.authorName, upvotes: sql<number>`count(${questionVotes.id})::int` })
    .from(questions)
    .leftJoin(questionVotes, eq(questionVotes.questionId, questions.id))
    .where(and(eq(questions.eventId, eventId), eq(questions.status, "approved")))
    .groupBy(questions.id)
    .orderBy(sql`count(${questionVotes.id}) desc`, desc(questions.createdAt));
  for (const q of qs) rows.push(["question", "", q.text, q.upvotes, q.authorName ?? ""]);

  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}
