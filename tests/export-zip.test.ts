// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { events, interactions, openTextResponses, participants, pollVotes, questions, sharedNotes, users, wordcloudEntries } from "@/db/schema";
import { createZip } from "@/lib/zip";
import { createTestDb, qaFor, truncateAll, workspaceFor } from "./helpers/db";

const { db, pool } = createTestDb();

let route: typeof import("@/app/api/events/[id]/export.zip/route");
let session: typeof import("@/lib/auth/session");
let hostCookie: string;
let otherCookie: string;
let eventId: string;
let participantIds: string[];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  route = await import("@/app/api/events/[id]/export.zip/route");
  session = await import("@/lib/auth/session");
});
afterAll(() => pool.end());

/** Reads a stored-only ZIP through its central directory and checks every CRC. */
function readZip(zip: Buffer) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    files[name] = data.toString("utf8");
    at += 46 + nameLength;
  }
  return files;
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
  await workspaceFor(db, other.id);
  otherCookie = `${session.SESSION_COOKIE}=${session.createSessionToken(other.id)}`;
  const [event] = await db
    .insert(events)
    .values({
      workspaceId: await workspaceFor(db, host.id),
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

  const [poll, cloud, notes, text] = await db
    .insert(interactions)
    .values([
      { eventId, type: "poll", title: 'Best, "fruit"?', position: 0, config: { options: [{ id: "a", label: "Apple" }, { id: "b", label: "Banana" }] } },
      { eventId, type: "wordcloud", title: "One word", position: 1, config: { prompt: "One word" } },
      { eventId, type: "sharedNotes", title: "Ideas", position: 3, config: { prompt: "Ideas" } },
      { eventId, type: "openText", title: "Ünïcode ✓", position: 4, config: { prompt: "Say" } },
    ])
    .returning();
  await db.insert(pollVotes).values([
    { interactionId: poll.id, participantId: participantIds[0], optionIds: ["a"] },
    { interactionId: poll.id, participantId: participantIds[1], optionIds: ["a", "b"] },
  ]);
  await db.insert(wordcloudEntries).values({ interactionId: cloud.id, participantId: participantIds[0], normalizedWord: "hope" });
  const qaId = await qaFor(db, eventId);
  await db.update(interactions).set({ position: 2 }).where(eq(interactions.id, qaId));
  await db.insert(questions).values([
    { eventId, interactionId: qaId, participantId: participantIds[0], text: "Named question", authorName: "Alice", status: "approved" },
    { eventId, interactionId: qaId, participantId: participantIds[2], text: "Pending one", status: "pending" },
  ]);
  await db.insert(sharedNotes).values({ interactionId: notes.id, participantId: participantIds[1], text: "A note" });
  await db.insert(openTextResponses).values({ interactionId: text.id, participantId: participantIds[2], text: "Calm" });
});

const get = (cookie: string | null, id = eventId) =>
  route.GET(new Request("http://localhost/x", { headers: cookie ? { cookie } : {} }), {
    params: Promise.resolve({ id }),
  });

async function zipOf(cookie = hostCookie) {
  const res = await get(cookie);
  expect(res.status).toBe(200);
  return { res, files: readZip(Buffer.from(await res.arrayBuffer())) };
}

test("the ZIP has one CSV per interaction, named by position and title, in order", async () => {
  const { res, files } = await zipOf();
  expect(res.headers.get("content-type")).toBe("application/zip");
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="Town-hall-results.zip"');
  expect(Object.keys(files)).toEqual([
    "01-Best-fruit.csv",
    "02-One-word.csv",
    "03-Q-A.csv",
    "04-Ideas.csv",
    "05-Unicode.csv",
  ]);
  expect(files["01-Best-fruit.csv"]).toBe('section,title,item,count,author\r\npoll,"Best, ""fruit""?",Apple,2,\r\npoll,"Best, ""fruit""?",Banana,1,\r\n');
  expect(files["02-One-word.csv"]).toBe("section,title,item,count,author\r\nwordcloud,One word,hope,1,\r\n");
  expect(files["03-Q-A.csv"]).toContain("question,,Named question,0,Alice");
  expect(files["04-Ideas.csv"]).toContain("sharedNotes,Ideas,A note,approved,no,0,");
  expect(files["05-Unicode.csv"]).toContain("openText,Ünïcode ✓,Calm,no");
});

test("an event with no interactions gives an empty archive", async () => {
  await db.delete(interactions);
  const { files } = await zipOf();
  expect(files).toEqual({});
});

test("no participant ids, nicknames or pending questions appear in any file", async () => {
  const { files } = await zipOf();
  const text = Object.values(files).join("\n");
  for (const id of participantIds) expect(text).not.toContain(id);
  expect(text).not.toContain("SecretNick");
  expect(text).not.toContain("Pending one");
  expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
});

test("requires export permission on the event: 401 anonymous, 404 for another workspace or unknown event", async () => {
  expect((await get(null)).status).toBe(401);
  expect((await get(otherCookie)).status).toBe(404);
  expect((await get(hostCookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  expect((await get(hostCookie, "nope")).status).toBe(404);
});

test("createZip output passes the system unzip integrity check", () => {
  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  try {
    const file = join(dir, "a.zip");
    writeFileSync(file, createZip([{ name: "a.csv", data: "x,y\r\n1,2\r\n" }, { name: "dir-ü.csv", data: new Uint8Array(70000).fill(7) }]));
    let out = "";
    try {
      out = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    expect(out).toContain("No errors detected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
