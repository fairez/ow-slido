// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, users } from "@/db/schema";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();
let getPresenterState: typeof import("@/lib/presenter").getPresenterState;
let eventId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  getPresenterState = (await import("@/lib/presenter")).getPresenterState;
});

beforeEach(async () => {
  await truncateAll(db);
  const [user] = await db.insert(users).values({ email: "host@example.com", passwordHash: "x" }).returning();
  const [event] = await db
    .insert(events)
    .values({
      workspaceId: await workspaceFor(db, user.id), ownerId: user.id,
      name: "Town hall",
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T11:00:00Z"),
      joinCode: "123456",
    })
    .returning();
  eventId = event.id;
});
afterAll(() => pool.end());

const config = { options: [{ id: "a", label: "Pizza" }, { id: "b", label: "Tacos" }], multiSelect: false, showResultsToParticipants: false };

test("null when nothing is live", async () => {
  await db.insert(interactions).values({ eventId, type: "poll", title: "Q", position: 0, state: "draft", config });
  expect(await getPresenterState(eventId)).toBeNull();
});

test("returns the live poll with zeroed counts", async () => {
  const [row] = await db.insert(interactions).values({ eventId, type: "poll", title: "Q", position: 0, state: "live", config }).returning();
  expect(await getPresenterState(eventId)).toMatchObject({ id: row.id, title: "Q", counts: { a: 0, b: 0 }, total: 0 });
});

test("returns approved notes for a live notes interaction and a named closed one", async () => {
  const { sharedNotes, participants } = await import("@/db/schema");
  const [row] = await db
    .insert(interactions)
    .values({ eventId, type: "sharedNotes", title: "Ideas", position: 0, state: "live", config: { maxNotes: 3, moderation: "open", showAuthorNames: false } })
    .returning();
  const [p] = await db.insert(participants).values({ eventId }).returning();
  await db.insert(sharedNotes).values([
    { interactionId: row.id, participantId: p.id, text: "shown", status: "approved" },
    { interactionId: row.id, participantId: p.id, text: "hidden", status: "pending" },
  ]);
  const live = await getPresenterState(eventId);
  expect(live).toMatchObject({ type: "sharedNotes", state: "live" });
  expect((live as { notes: { text: string }[] }).notes.map((n) => n.text)).toEqual(["shown"]);
  await db.update(interactions).set({ state: "closed" });
  expect(await getPresenterState(eventId)).toBeNull();
  expect(await getPresenterState(eventId, row.id)).toMatchObject({ type: "sharedNotes", state: "closed" });
});

test("returns visible responses for a live open-text interaction and a named closed one", async () => {
  const { openTextResponses, participants } = await import("@/db/schema");
  const [row] = await db
    .insert(interactions)
    .values({ eventId, type: "openText", title: "Fix?", position: 0, state: "live", config: { prompt: "Fix?", maxResponsesPerParticipant: 2 } })
    .returning();
  const [p] = await db.insert(participants).values({ eventId }).returning();
  await db.insert(openTextResponses).values([
    { interactionId: row.id, participantId: p.id, text: "shown" },
    { interactionId: row.id, participantId: p.id, text: "hidden", hidden: true },
  ]);
  const live = await getPresenterState(eventId);
  expect(live).toMatchObject({ type: "openText", state: "live" });
  expect(JSON.stringify(live)).not.toContain(p.id);
  expect((live as { responses: { text: string }[] }).responses.map((r) => r.text)).toEqual(["shown"]);
  await db.update(interactions).set({ state: "closed" });
  expect(await getPresenterState(eventId)).toBeNull();
  expect(await getPresenterState(eventId, row.id)).toMatchObject({ type: "openText", state: "closed" });
});

test("returns rating results for a live rating and a named closed one", async () => {
  const { ratingResponses, participants } = await import("@/db/schema");
  const [row] = await db
    .insert(interactions)
    .values({ eventId, type: "rating", title: "Rate it", position: 0, state: "live", config: { prompt: "Rate it", scale: "stars5" } })
    .returning();
  const ps = await db.insert(participants).values([{ eventId }, { eventId }]).returning();
  await db.insert(ratingResponses).values([
    { interactionId: row.id, participantId: ps[0].id, value: 4 },
    { interactionId: row.id, participantId: ps[1].id, value: 5 },
  ]);
  const live = await getPresenterState(eventId);
  expect(live).toMatchObject({ type: "rating", state: "live", results: { total: 2, average: 4.5, distribution: [0, 0, 0, 1, 1] } });
  expect(JSON.stringify(live)).not.toContain(ps[0].id);
  await db.update(interactions).set({ state: "closed" });
  expect(await getPresenterState(eventId)).toBeNull();
  expect(await getPresenterState(eventId, row.id)).toMatchObject({ type: "rating", state: "closed" });
});

test("returns ranking scores for a live ranking and a named closed one, without participant ids", async () => {
  const { rankingResponses, participants } = await import("@/db/schema");
  const options = [
    { id: "a", text: "Alpha" },
    { id: "b", text: "Beta" },
  ];
  const [row] = await db
    .insert(interactions)
    .values({ eventId, type: "ranking", title: "Rank", position: 0, state: "live", config: { prompt: "Rank", options } })
    .returning();
  const ps = await db.insert(participants).values([{ eventId }, { eventId }]).returning();
  await db.insert(rankingResponses).values([
    { interactionId: row.id, participantId: ps[0].id, order: ["b", "a"] },
    { interactionId: row.id, participantId: ps[1].id, order: ["b", "a"] },
  ]);
  const live = await getPresenterState(eventId);
  expect(live).toMatchObject({
    type: "ranking",
    state: "live",
    results: { total: 2, options: [{ text: "Beta", score: 4, rank: 1 }, { text: "Alpha", score: 2, rank: 2 }] },
  });
  expect(JSON.stringify(live)).not.toContain(ps[0].id);
  await db.update(interactions).set({ state: "paused" });
  expect(await getPresenterState(eventId)).toBeNull();
  await db.update(interactions).set({ state: "closed" });
  expect(await getPresenterState(eventId, row.id)).toMatchObject({ type: "ranking", state: "closed" });
});

test("returns a live quiz question without the answer, and the correct options once it is closed", async () => {
  const { participants, quizAnswers } = await import("@/db/schema");
  const options = [
    { id: "a", text: "Alpha" },
    { id: "b", text: "Beta" },
  ];
  const [row] = await db
    .insert(interactions)
    .values({
      eventId,
      type: "quiz",
      title: "Quiz",
      position: 0,
      state: "live",
      config: { prompt: "Which?", options, correctOptionIds: ["b"], timeLimitSeconds: 20, points: 1000 },
      startedAt: new Date(),
      deadlineAt: new Date(Date.now() + 20_000),
    })
    .returning();
  const ps = await db.insert(participants).values([{ eventId }, { eventId }]).returning();
  await db.insert(quizAnswers).values([
    { interactionId: row.id, participantId: ps[0].id, optionIds: ["b"], elapsedMs: 1000, correct: true, points: 950 },
    { interactionId: row.id, participantId: ps[1].id, optionIds: ["a"], elapsedMs: 2000, correct: false, points: 0 },
  ]);
  const live = await getPresenterState(eventId);
  expect(live).toMatchObject({ type: "quiz", state: "live", prompt: "Which?", timeLimitSeconds: 20, total: 2, results: null });
  expect(live && live.type === "quiz" && live.options).toEqual(options);
  expect(typeof (live as { serverNow: number }).serverNow).toBe("number");
  expect((live as { deadlineAt: number }).deadlineAt).toBe(row.deadlineAt!.getTime());
  expect(JSON.stringify(live)).not.toContain("correctOptionIds");
  expect(JSON.stringify(live)).not.toContain(ps[0].id);
  await db.update(interactions).set({ state: "paused" });
  expect(await getPresenterState(eventId)).toBeNull();
  await db.update(interactions).set({ state: "closed" });
  const closed = await getPresenterState(eventId, row.id);
  expect(closed).toMatchObject({
    type: "quiz",
    state: "closed",
    total: 2,
    results: {
      correctPercent: 50,
      options: [
        { text: "Alpha", correct: false, count: 1 },
        { text: "Beta", correct: true, count: 1 },
      ],
    },
  });
});
