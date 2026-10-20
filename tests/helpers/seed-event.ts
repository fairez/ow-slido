import {
  aiCalls,
  events,
  interactions,
  noteAnalyses,
  openTextResponses,
  participants,
  pollVotes,
  questionVotes,
  questions,
  quizAnswers,
  quizScores,
  rankingResponses,
  ratingResponses,
  sharedNoteVotes,
  sharedNotes,
  surveyAnswers,
  surveySubmissions,
  wordcloudEntries,
} from "@/db/schema";
import type { createTestDb } from "./db";

type Db = ReturnType<typeof createTestDb>["db"];

/** Everything one participant leaves behind in an event: a row in each participant-linked table. */
async function contribute(
  db: Db,
  eventId: string,
  participantId: string,
  interactionIds: Record<"poll" | "wordcloud" | "qa" | "sharedNotes" | "openText" | "rating" | "ranking" | "quiz" | "survey", string>,
  label: string,
) {
  await db.insert(pollVotes).values({ interactionId: interactionIds.poll, participantId, optionIds: ["a"] });
  await db.insert(wordcloudEntries).values({ interactionId: interactionIds.wordcloud, participantId, normalizedWord: label });
  const [question] = await db
    .insert(questions)
    .values({ eventId, interactionId: interactionIds.qa, participantId, text: `${label} asks`, authorName: label, status: "approved" })
    .returning();
  const [note] = await db
    .insert(sharedNotes)
    .values({ interactionId: interactionIds.sharedNotes, participantId, text: `${label} note`, authorName: label })
    .returning();
  await db.insert(openTextResponses).values({ interactionId: interactionIds.openText, participantId, text: `${label} says` });
  await db.insert(ratingResponses).values({ interactionId: interactionIds.rating, participantId, value: 4 });
  await db.insert(rankingResponses).values({ interactionId: interactionIds.ranking, participantId, order: ["a", "b"] });
  await db.insert(quizAnswers).values({
    interactionId: interactionIds.quiz,
    participantId,
    optionIds: ["a"],
    elapsedMs: 1000,
    correct: true,
    points: 900,
  });
  await db.insert(quizScores).values({ eventId, participantId, points: 900, answeredCount: 1, correctCount: 1, totalElapsedMs: 1000 });
  const [submission] = await db
    .insert(surveySubmissions)
    .values({ interactionId: interactionIds.survey, participantId })
    .returning();
  await db.insert(surveyAnswers).values({ submissionId: submission.id, questionId: "q1", value: `${label} answer` });
  return { question, note };
}

/**
 * Inserts a workspace event with one interaction of every type, two participants who each answered
 * everything, and votes in both directions on each other's question and note. Also an AI analysis and
 * an AI call, so tests can check every table that reaches the event.
 */
export async function seedFullEvent(db: Db, workspaceId: string, ownerId: string) {
  const [event] = await db
    .insert(events)
    .values({
      ownerId,
      workspaceId,
      createdBy: ownerId,
      name: "Town hall",
      startsAt: new Date("2030-01-01T09:00:00Z"),
      endsAt: new Date("2030-01-01T10:00:00Z"),
      joinCode: String(100000 + Math.floor(Math.random() * 899999)),
    })
    .returning();
  const types = ["poll", "wordcloud", "qa", "sharedNotes", "openText", "rating", "ranking", "quiz", "survey"] as const;
  const made = await db
    .insert(interactions)
    .values(types.map((type, position) => ({ eventId: event.id, type, title: type, position, state: "closed" as const })))
    .returning();
  const ids = Object.fromEntries(made.map((row) => [row.type, row.id])) as Record<(typeof types)[number], string>;

  const [a, b] = await db
    .insert(participants)
    .values([
      { eventId: event.id, nickname: "Ayu" },
      { eventId: event.id, nickname: "Budi" },
    ])
    .returning();
  const mine = await contribute(db, event.id, a.id, ids, "ayu");
  const theirs = await contribute(db, event.id, b.id, ids, "budi");
  await db.insert(questionVotes).values([
    { questionId: theirs.question.id, participantId: a.id },
    { questionId: mine.question.id, participantId: b.id },
  ]);
  await db.insert(sharedNoteVotes).values([
    { noteId: theirs.note.id, participantId: a.id },
    { noteId: mine.note.id, participantId: b.id },
  ]);
  await db.insert(noteAnalyses).values({ interactionId: ids.sharedNotes, notesSnapshotHash: "h", noteCount: 2 });
  await db.insert(aiCalls).values({ eventId: event.id, kind: "analysis", provider: "mock", model: "mock" });
  return { event, interactionIds: ids, a, b, mine, theirs };
}
