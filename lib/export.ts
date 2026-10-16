import { and, asc, desc, eq, sql } from "drizzle-orm";
import { interactions, openTextResponses, pollVotes, questions, questionVotes, sharedNotes, sharedNoteVotes } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { PollConfig } from "@/lib/polls";
import type { RatingConfig } from "@/lib/interaction-config";
import { computeResults } from "@/lib/rating";
import { getWordcloudResults } from "@/lib/wordclouds";

export const EXPORT_HEADER = ["section", "title", "item", "count", "author"] as const;
export const NOTES_EXPORT_HEADER = ["section", "title", "note", "status", "pinned", "upvotes", "author"] as const;
export const OPEN_TEXT_EXPORT_HEADER = ["section", "title", "response", "highlighted"] as const;
export const RATING_EXPORT_HEADER = ["section", "title", "scale", "average", "total", "value", "count"] as const;

/** Quotes a field for CSV; a leading formula character is neutralised so spreadsheets don't evaluate user text. */
export function csvField(value: string | number) {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One flat table: poll option votes, word counts and approved questions with upvotes,
 * followed by separate shared-notes, open-text and rating tables.
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
    } else if (interaction.type === "wordcloud") {
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

  const notesInteractions = list.filter((i) => i.type === "sharedNotes");
  if (notesInteractions.length > 0) {
    // Its own table: notes carry status and pinned, which the flat table has no columns for.
    const noteRows: (string | number)[][] = [[...NOTES_EXPORT_HEADER]];
    for (const interaction of notesInteractions) {
      const notes = await db
        .select({
          text: sharedNotes.text,
          status: sharedNotes.status,
          pinned: sharedNotes.pinned,
          authorName: sharedNotes.authorName,
          upvotes: sql<number>`count(${sharedNoteVotes.id})::int`,
        })
        .from(sharedNotes)
        .leftJoin(sharedNoteVotes, eq(sharedNoteVotes.noteId, sharedNotes.id))
        .where(eq(sharedNotes.interactionId, interaction.id))
        .groupBy(sharedNotes.id)
        .orderBy(sql`count(${sharedNoteVotes.id}) desc`, desc(sharedNotes.createdAt));
      for (const n of notes) {
        noteRows.push(["sharedNotes", interaction.title, n.text, n.status, n.pinned ? "yes" : "no", n.upvotes, n.authorName ?? ""]);
      }
    }
    rows.push([], ...noteRows);
  }

  const openTextInteractions = list.filter((i) => i.type === "openText");
  if (openTextInteractions.length > 0) {
    const textRows: (string | number)[][] = [[...OPEN_TEXT_EXPORT_HEADER]];
    for (const interaction of openTextInteractions) {
      // Hidden responses are the host's moderation; they stay out of the file.
      const responses = await db
        .select({ text: openTextResponses.text, highlighted: openTextResponses.highlighted })
        .from(openTextResponses)
        .where(and(eq(openTextResponses.interactionId, interaction.id), eq(openTextResponses.hidden, false)))
        .orderBy(desc(openTextResponses.highlighted), desc(openTextResponses.createdAt));
      for (const r of responses) textRows.push(["openText", interaction.title, r.text, r.highlighted ? "yes" : "no"]);
    }
    rows.push([], ...textRows);
  }

  const ratingInteractions = list.filter((i) => i.type === "rating");
  if (ratingInteractions.length > 0) {
    const ratingRows: (string | number)[][] = [[...RATING_EXPORT_HEADER]];
    for (const interaction of ratingInteractions) {
      const scale = (interaction.config as Partial<RatingConfig>).scale === "numeric10" ? "numeric10" : "stars5";
      const results = await computeResults(db, interaction.id, scale);
      results.distribution.forEach((count, i) => {
        ratingRows.push(["rating", interaction.title, scale, results.average ?? "", results.total, i + 1, count]);
      });
    }
    rows.push([], ...ratingRows);
  }

  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}
