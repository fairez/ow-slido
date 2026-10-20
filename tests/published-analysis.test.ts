// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, noteAnalyses, participants, sharedNotes, users } from "@/db/schema";
import { createTestDb, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
let published: { GET: (req: Request, ctx: Ctx) => Promise<Response> };
let lib: typeof import("@/lib/note-analysis");
let tokens: typeof import("@/lib/participant-token");
let publisher: typeof import("@/lib/realtime/publisher");
let eventId: string;
let interactionId: string;
let participantId: string;
let noteId: string;

const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
const get = (id: string, joined = true) =>
  published.GET(
    new Request("http://localhost/api", {
      headers: joined
        ? { cookie: `${tokens.participantCookieName(eventId)}=${tokens.createParticipantToken(eventId, participantId)}` }
        : {},
    }),
    ctx(id),
  );

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  published = await import("@/app/api/interactions/[id]/analysis/published/route");
  lib = await import("@/lib/note-analysis");
  tokens = await import("@/lib/participant-token");
  publisher = await import("@/lib/realtime/publisher");
});

beforeEach(async () => {
  await truncateAll(db);
  const [{ id: ownerId }] = await db.insert(users).values({ email: "h@example.com", passwordHash: "x" }).returning();
  const [ev] = await db
    .insert(events)
    .values({ workspaceId: await workspaceFor(db, ownerId), ownerId, name: "E", joinCode: "1234", startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) })
    .returning();
  eventId = ev.id;
  const [it] = await db
    .insert(interactions)
    .values({ eventId, type: "sharedNotes", title: "T", state: "live", position: 1, config: {} } as never)
    .returning();
  interactionId = it.id;
  [{ id: participantId }] = await db.insert(participants).values({ eventId }).returning();
  [{ id: noteId }] = await db.insert(sharedNotes).values({ interactionId, participantId, text: "secret note text", status: "approved" }).returning();
  await db.insert(noteAnalyses).values({
    interactionId,
    status: "done",
    noteCount: 1,
    notesSnapshotHash: "h",
    summary: "The summary",
    categories: [{ name: "Cat", description: "d", noteIds: [noteId] }],
    keywords: [{ word: "kw", weight: 3 }],
    published: false,
  } as never);
});
afterAll(async () => {
  await pool.end();
});

test("an unpublished analysis is never returned to participants", async () => {
  const res = await get(interactionId);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ analysis: null });
});

test("a published analysis returns summary, category counts and keywords without note ids or text", async () => {
  await lib.setAnalysisPublished(interactionId, true);
  const text = await (await get(interactionId)).text();
  expect(JSON.parse(text)).toEqual({
    analysis: {
      summary: "The summary",
      categories: [{ name: "Cat", description: "d", count: 1 }],
      keywords: [{ word: "kw", weight: 3 }],
    },
  });
  expect(text).not.toContain(noteId);
  expect(text).not.toContain("secret note text");
});

test("unpublishing hides it again", async () => {
  await lib.setAnalysisPublished(interactionId, true);
  await lib.setAnalysisPublished(interactionId, false);
  expect(await (await get(interactionId)).json()).toEqual({ analysis: null });
});

test("requires a joined participant and a started notes interaction", async () => {
  expect((await get(interactionId, false)).status).toBe(401);
  expect((await get("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  await db.update(interactions).set({ state: "draft" }).where(eq(interactions.id, interactionId));
  expect((await get(interactionId)).status).toBe(404);
});

test("publishing and editing a published analysis notify participants", async () => {
  const sent: { name: string; payload: unknown }[] = [];
  publisher.setPublisher({ publish: (_e, name, payload) => void sent.push({ name, payload }) });
  try {
    await lib.setAnalysisPublished(interactionId, true);
    await lib.editAnalysis(interactionId, { op: "setSummary", summary: "New" });
    await vi.waitFor(() => expect(sent.filter((m) => m.name === "analysis:published")).toHaveLength(2));
    const published = sent.filter((m) => m.name === "analysis:published");
    expect(JSON.stringify(published[1].payload)).toContain("New");
    // Hosts' open pages are told too, with no content, so they refetch instead of polling.
    const updated = sent.filter((m) => m.name === "analysis:updated");
    expect(updated.length).toBeGreaterThanOrEqual(2);
    expect(updated.every((m) => JSON.stringify(m.payload) === JSON.stringify({ interactionId }))).toBe(true);
  } finally {
    publisher.setPublisher(null);
  }
});
