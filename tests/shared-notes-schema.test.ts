// @vitest-environment node
import { afterAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import {
  events,
  interactions,
  participants,
  sharedNotes,
  sharedNoteVotes,
  users,
} from "@/db/schema";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

async function setup() {
  const [u] = await db.insert(users).values({ email: "a@b.co", passwordHash: "h" }).returning();
  const [e] = await db
    .insert(events)
    .values({
      workspaceId: await workspaceFor(db, u.id), ownerId: u.id,
      name: "E",
      startsAt: new Date("2026-01-01"),
      endsAt: new Date("2026-01-02"),
      joinCode: "123456",
    })
    .returning();
  const [i] = await db
    .insert(interactions)
    .values({ eventId: e.id, type: "sharedNotes", title: "Notes", position: 0 })
    .returning();
  const [p] = await db.insert(participants).values({ eventId: e.id }).returning();
  return { e, i, p };
}

test("notes default to approved, unpinned and anonymous", async () => {
  const { i, p } = await setup();
  const [n] = await db
    .insert(sharedNotes)
    .values({ interactionId: i.id, participantId: p.id, text: "hello" })
    .returning();
  expect(n.status).toBe("approved");
  expect(n.pinned).toBe(false);
  expect(n.authorName).toBeNull();
  expect(n.updatedAt).toBeInstanceOf(Date);
});

test("rejects empty text, text over 5000 chars and unknown status", async () => {
  const { i, p } = await setup();
  const base = { interactionId: i.id, participantId: p.id };
  await expect(db.insert(sharedNotes).values({ ...base, text: "" })).rejects.toThrow();
  await expect(db.insert(sharedNotes).values({ ...base, text: "x".repeat(5001) })).rejects.toThrow();
  await expect(
    db.insert(sharedNotes).values({ ...base, text: "ok", status: "bogus" as "pending" }),
  ).rejects.toThrow();
  await db.insert(sharedNotes).values({ ...base, text: "x".repeat(5000) });
});

test("a participant can upvote a note only once", async () => {
  const { i, p } = await setup();
  const [n] = await db
    .insert(sharedNotes)
    .values({ interactionId: i.id, participantId: p.id, text: "a" })
    .returning();
  await db.insert(sharedNoteVotes).values({ noteId: n.id, participantId: p.id });
  await expect(
    db.insert(sharedNoteVotes).values({ noteId: n.id, participantId: p.id }),
  ).rejects.toThrow();
});

test("deleting the event cascades to notes and votes", async () => {
  const { e, i, p } = await setup();
  const [n] = await db
    .insert(sharedNotes)
    .values({ interactionId: i.id, participantId: p.id, text: "a" })
    .returning();
  await db.insert(sharedNoteVotes).values({ noteId: n.id, participantId: p.id });
  await db.delete(events).where(eq(events.id, e.id));
  expect(await db.select().from(sharedNotes)).toHaveLength(0);
  expect(await db.select().from(sharedNoteVotes)).toHaveLength(0);
});
