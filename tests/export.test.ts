// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, noteAnalyses, openTextResponses, participants, pollVotes, ratingResponses, questions, questionVotes, sharedNotes, sharedNoteVotes, users, wordcloudEntries } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

let route: typeof import("@/app/api/events/[id]/export.csv/route");
let session: typeof import("@/lib/auth/session");
let hostCookie: string;
let otherCookie: string;
let eventId: string;
let participantIds: string[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  route = await import("@/app/api/events/[id]/export.csv/route");
  session = await import("@/lib/auth/session");
});
afterAll(() => pool.end());

/** Minimal RFC 4180 parser for the assertions. */
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") continue;
    else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  return rows;
}

beforeEach(async () => {
  await truncateAll(db);
  const [host, other] = await db
    .insert(users)
    .values([
      { email: "h@example.com", passwordHash: "x" },
      { email: "o@example.com", passwordHash: "x" },
    ])
    .returning();
  hostCookie = `${session.SESSION_COOKIE}=${session.createSessionToken(host.id)}`;
  otherCookie = `${session.SESSION_COOKIE}=${session.createSessionToken(other.id)}`;
  const [event] = await db
    .insert(events)
    .values({
      ownerId: host.id,
      name: "Town hall",
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T11:00:00Z"),
      joinCode: "111111",
    })
    .returning();
  eventId = event.id;
  const ps = await db
    .insert(participants)
    .values([{ eventId, nickname: "SecretNick" }, { eventId }, { eventId }])
    .returning();
  participantIds = ps.map((p) => p.id);

  const [poll, cloud] = await db
    .insert(interactions)
    .values([
      {
        eventId,
        type: "poll",
        title: 'Best, "fruit"?',
        position: 0,
        config: { options: [{ id: "a", label: "Apple" }, { id: "b", label: "Banana" }, { id: "c", label: "Cherry" }] },
      },
      { eventId, type: "wordcloud", title: "One word", position: 1, config: { prompt: "One word" } },
    ])
    .returning();
  await db.insert(pollVotes).values([
    { interactionId: poll.id, participantId: participantIds[0], optionIds: ["a", "b"] },
    { interactionId: poll.id, participantId: participantIds[1], optionIds: ["a"] },
  ]);
  await db.insert(wordcloudEntries).values([
    { interactionId: cloud.id, participantId: participantIds[0], normalizedWord: "hope" },
    { interactionId: cloud.id, participantId: participantIds[1], normalizedWord: "hope" },
    { interactionId: cloud.id, participantId: participantIds[2], normalizedWord: "badword", hidden: true },
  ]);
  const qs = await db
    .insert(questions)
    .values([
      { eventId, participantId: participantIds[0], text: "Named question", authorName: "Alice", status: "approved" },
      { eventId, participantId: participantIds[1], text: "=SUM(A1)", status: "approved" },
      { eventId, participantId: participantIds[2], text: "Pending one", status: "pending" },
    ])
    .returning();
  await db.insert(questionVotes).values([
    { questionId: qs[1].id, participantId: participantIds[0] },
    { questionId: qs[1].id, participantId: participantIds[2] },
    { questionId: qs[0].id, participantId: participantIds[1] },
  ]);
});

const get = (cookie: string | null, id = eventId) =>
  route.GET(new Request("http://localhost/x", { headers: cookie ? { cookie } : {} }), {
    params: Promise.resolve({ id }),
  });

test("owner gets a CSV attachment with poll, word and question rows", async () => {
  const res = await get(hostCookie);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/csv");
  expect(res.headers.get("content-disposition")).toContain("attachment");
  const rows = parseCsv(await res.text());
  expect(rows[0]).toEqual(["section", "title", "item", "count", "author"]);
  expect(rows.slice(1)).toEqual([
    ["poll", 'Best, "fruit"?', "Apple", "2", ""],
    ["poll", 'Best, "fruit"?', "Banana", "1", ""],
    ["poll", 'Best, "fruit"?', "Cherry", "0", ""],
    ["wordcloud", "One word", "hope", "2", ""],
    ["question", "", "'=SUM(A1)", "2", ""],
    ["question", "", "Named question", "1", "Alice"],
  ]);
});

test("no participant identifiers, nicknames, hidden words or pending questions appear", async () => {
  const text = await (await get(hostCookie)).text();
  for (const id of participantIds) expect(text).not.toContain(id);
  expect(text).not.toContain("SecretNick");
  expect(text).not.toContain("badword");
  expect(text).not.toContain("Pending one");
  expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
});

test("requires the owner: 401 anonymous, 404 for another host or unknown event", async () => {
  expect((await get(null)).status).toBe(401);
  expect((await get(otherCookie)).status).toBe(404);
  expect((await get(hostCookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  expect((await get(hostCookie, "nope")).status).toBe(404);
});

test("shared notes get their own section with status, pinned, upvotes and only a provided author name", async () => {
  const [board] = await db
    .insert(interactions)
    .values({ eventId, type: "sharedNotes", title: "Ideas", position: 2, config: { prompt: "Ideas" } })
    .returning();
  const notes = await db
    .insert(sharedNotes)
    .values([
      { interactionId: board.id, participantId: participantIds[0], text: "Named, \"note\"", authorName: "Bea", pinned: true },
      { interactionId: board.id, participantId: participantIds[1], text: "Anonymous note" },
      { interactionId: board.id, participantId: participantIds[2], text: "Waiting", status: "pending" },
    ])
    .returning();
  await db.insert(sharedNoteVotes).values([
    { noteId: notes[1].id, participantId: participantIds[0] },
    { noteId: notes[1].id, participantId: participantIds[2] },
    { noteId: notes[0].id, participantId: participantIds[1] },
  ]);

  const text = await (await get(hostCookie)).text();
  const rows = parseCsv(text);
  const at = rows.findIndex((r) => r[0] === "section" && r[2] === "note");
  expect(rows[at - 1]).toEqual([""]);
  expect(rows[at]).toEqual(["section", "title", "note", "status", "pinned", "upvotes", "author"]);
  expect(rows.slice(at + 1)).toEqual([
    ["sharedNotes", "Ideas", "Anonymous note", "approved", "no", "2", ""],
    ["sharedNotes", "Ideas", 'Named, "note"', "approved", "yes", "1", "Bea"],
    ["sharedNotes", "Ideas", "Waiting", "pending", "no", "0", ""],
  ]);
  for (const id of participantIds) expect(text).not.toContain(id);
  expect(text).not.toContain("SecretNick");
  expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
});

test("open text and rating get their own sections; hidden responses and participant ids stay out", async () => {
  const [ot] = await db
    .insert(interactions)
    .values({ eventId, type: "openText", title: "One word", position: 3, config: { prompt: "One word" } })
    .returning();
  await db.insert(openTextResponses).values([
    { interactionId: ot.id, participantId: participantIds[0], text: "Calm, \"quiet\"", highlighted: true },
    { interactionId: ot.id, participantId: participantIds[1], text: "Plain" },
    { interactionId: ot.id, participantId: participantIds[2], text: "Secret hidden", hidden: true },
  ]);
  const [rt] = await db
    .insert(interactions)
    .values({ eventId, type: "rating", title: "Session", position: 4, config: { prompt: "Rate", scale: "stars5" } })
    .returning();
  await db.insert(ratingResponses).values([
    { interactionId: rt.id, participantId: participantIds[0], value: 5 },
    { interactionId: rt.id, participantId: participantIds[1], value: 4 },
    { interactionId: rt.id, participantId: participantIds[2], value: 4 },
  ]);

  const text = await (await get(hostCookie)).text();
  const rows = parseCsv(text);
  const t = rows.findIndex((r) => r[0] === "section" && r[2] === "response");
  expect(rows[t - 1]).toEqual([""]);
  expect(rows[t]).toEqual(["section", "title", "response", "highlighted"]);
  expect(rows.slice(t + 1, t + 3)).toEqual([
    ["openText", "One word", 'Calm, "quiet"', "yes"],
    ["openText", "One word", "Plain", "no"],
  ]);
  expect(text).not.toContain("Secret hidden");

  const r = rows.findIndex((x) => x[0] === "section" && x[2] === "scale");
  expect(rows[r - 1]).toEqual([""]);
  expect(rows[r]).toEqual(["section", "title", "scale", "average", "total", "value", "count"]);
  expect(rows.slice(r + 1)).toEqual([
    ["rating", "Session", "stars5", "4.33", "3", "1", "0"],
    ["rating", "Session", "stars5", "4.33", "3", "2", "0"],
    ["rating", "Session", "stars5", "4.33", "3", "3", "0"],
    ["rating", "Session", "stars5", "4.33", "3", "4", "2"],
    ["rating", "Session", "stars5", "4.33", "3", "5", "1"],
  ]);
  for (const id of participantIds) expect(text).not.toContain(id);
});

test("analysis section: summary, categories with counts, keywords, model, run time, AI and edited markers; no ids", async () => {
  const [board] = await db
    .insert(interactions)
    .values({ eventId, type: "sharedNotes", title: "Ideas", position: 2, config: { prompt: "Ideas" } })
    .returning();
  const [note] = await db
    .insert(sharedNotes)
    .values({ interactionId: board.id, participantId: participantIds[0], text: "Plain note" })
    .returning();
  expect(parseCsv(await (await get(hostCookie)).text()).some((r) => r[0] === "analysis")).toBe(false);

  const finishedAt = new Date("2026-10-16T10:00:00Z");
  await db.insert(noteAnalyses).values({
    interactionId: board.id,
    status: "done",
    noteCount: 1,
    notesSnapshotHash: "h",
    summary: "People want, more time",
    categories: [{ name: "Time", description: "d", noteIds: [note.id, "x"] }],
    keywords: [{ word: "time", weight: 5 }],
    edited: true,
    model: "mock-1",
    finishedAt,
  } as never);
  await db.insert(noteAnalyses).values({ interactionId: board.id, status: "failed", noteCount: 1, notesSnapshotHash: "h" } as never);

  const text = await (await get(hostCookie)).text();
  const rows = parseCsv(text);
  const at = rows.findIndex((r) => r[0] === "section" && r[2] === "kind");
  expect(rows[at - 1]).toEqual([""]);
  expect(rows[at]).toEqual(["section", "title", "kind", "item", "count", "weight", "model", "run_at", "ai_generated", "edited"]);
  const tail = ["mock-1", finishedAt.toISOString(), "yes", "yes"];
  expect(rows.slice(at + 1)).toEqual([
    ["analysis", "Ideas", "summary", "People want, more time", "", "", ...tail],
    ["analysis", "Ideas", "category", "Time", "2", "", ...tail],
    ["analysis", "Ideas", "keyword", "time", "", "5", ...tail],
  ]);
  expect(text).not.toContain(note.id);
  for (const id of participantIds) expect(text).not.toContain(id);
});
