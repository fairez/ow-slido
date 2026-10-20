// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, participants, pollVotes, questions, users } from "@/db/schema";
import { INTERACTION_MODULES, interactionModule } from "@/lib/interaction-modules";
import { buildInteractionCsv } from "@/lib/export";
import { createTestDb, qaFor, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();
let eventId: string;

beforeAll(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});
afterAll(() => pool.end());

beforeEach(async () => {
  await truncateAll(db);
  const [user] = await db.insert(users).values({ email: "h@example.com", passwordHash: "x" }).returning();
  const [event] = await db
    .insert(events)
    .values({
      workspaceId: await workspaceFor(db, user.id),
      ownerId: user.id,
      name: "Modules",
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T11:00:00Z"),
      joinCode: "222222",
    })
    .returning();
  eventId = event.id;
});

test("every type the interactions table accepts has a module", () => {
  const stored = interactions.type.enumValues;
  expect([...INTERACTION_MODULES.map((m) => m.type)].sort()).toEqual([...stored].sort());
  for (const type of stored) expect(interactionModule(type).type).toBe(type);
});

test("an unregistered type throws instead of being skipped", () => {
  expect(() => interactionModule("hologram")).toThrow(/hologram/);
});

test("validateConfig accepts a good body and rejects a bad one for every type", () => {
  const good: Record<string, unknown> = {
    poll: { question: "Best?", options: ["A", "B"] },
    wordcloud: { prompt: "One word", maxEntriesPerParticipant: 3 },
    qa: { prompt: "Ask away" },
    sharedNotes: { prompt: "Ideas" },
    openText: { prompt: "Thoughts" },
    rating: { prompt: "How was it?" },
    ranking: { prompt: "Rank", options: ["A", "B"] },
  };
  for (const m of INTERACTION_MODULES) {
    expect(m.validateConfig(good[m.type], false), m.type).toMatchObject({ ok: true });
    expect(m.validateConfig(null, false), m.type).toMatchObject({ ok: false, error: "api.invalidBody" });
  }
});

test("csv and responseCount of each type come from its module", async () => {
  const [poll, qa] = await db
    .insert(interactions)
    .values([
      { eventId, type: "poll", title: "Best?", position: 0, config: { options: [{ id: "a", label: "Apple" }, { id: "b", label: "Banana" }] } },
      { eventId, type: "rating", title: "Rate", position: 1, config: { prompt: "Rate", scale: "stars5" } },
    ])
    .returning();
  const [p] = await db.insert(participants).values({ eventId }).returning();
  await db.insert(pollVotes).values({ interactionId: poll.id, participantId: p.id, optionIds: ["a"] });
  const qaId = await qaFor(db, eventId);
  await db.insert(questions).values([
    { eventId, interactionId: qaId, participantId: p.id, text: "Shown", status: "approved" },
    { eventId, interactionId: qaId, participantId: p.id, text: "Gone", status: "rejected" },
  ]);

  expect(await interactionModule("poll").responseCount(poll.id)).toBe(1);
  expect(await interactionModule("qa").responseCount(qaId)).toBe(1);
  expect(await interactionModule("rating").responseCount(qa.id)).toBe(0);

  expect(await buildInteractionCsv("poll", poll.id)).toBe(
    "section,title,item,count,author\r\npoll,Best?,Apple,1,\r\npoll,Best?,Banana,0,\r\n",
  );
  const text = await buildInteractionCsv("qa", qaId);
  expect(text).toContain("Shown");
  expect(text).not.toContain("Gone");
  expect(text).not.toContain(p.id);
});
