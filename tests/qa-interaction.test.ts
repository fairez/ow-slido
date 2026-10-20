// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, participants, questionVotes, questions, users } from "@/db/schema";
import { parseNewInteractionInput } from "@/lib/interaction-config";
import { ensureQaInteraction } from "@/lib/questions";
import { createTestDb, qaFor, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string; interactionId: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: Handler };
let item: { PATCH: Handler };
let duplicate: { POST: Handler };
let signup: (req: Request) => Promise<Response>;
let hostCookie: string;
let eventId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  item = await import("@/app/api/events/[id]/interactions/[interactionId]/route");
  duplicate = await import("@/app/api/events/[id]/interactions/[interactionId]/duplicate/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
});
afterAll(() => pool.end());

const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", cookie: hostCookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string, interactionId = id): Ctx => ({ params: Promise.resolve({ id, interactionId }) });

beforeEach(async () => {
  await truncateAll(db);
  const res = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "host@b.co", password: "password123" }),
    }),
  );
  await db.update(users).set({ emailVerifiedAt: new Date() });
  hostCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const created = await eventsRoute.POST(
    req("POST", { name: "E", startsAt: "2026-01-01T10:00:00Z", endsAt: "2026-01-01T12:00:00Z" }),
  );
  eventId = (await created.json()).event.id;
});

const create = async (body: object) => {
  const res = await collection.POST(req("POST", body), ctx(eventId));
  return { res, json: await res.json() };
};

test("creates a qa interaction with the default title and config", async () => {
  const { res, json } = await create({ type: "qa" });
  expect(res.status).toBe(201);
  expect(json.interaction).toMatchObject({
    type: "qa",
    title: "Q&A",
    state: "draft",
    config: { prompt: "Ask a question", moderation: "open" },
  });
});

test("creates a qa interaction with its own title, prompt and moderation", async () => {
  const { res, json } = await create({ type: "qa", title: "Ask the CEO", prompt: "What is on your mind?", moderation: "moderated" });
  expect(res.status).toBe(201);
  expect(json.interaction).toMatchObject({
    title: "Ask the CEO",
    config: { prompt: "What is on your mind?", moderation: "moderated" },
  });
});

test.each([
  { prompt: "" },
  { prompt: "x".repeat(201) },
  { prompt: 5 },
  { title: "" },
  { moderation: "strict" },
])("rejects invalid qa config %j with 400", async (rest) => {
  const { res } = await create({ type: "qa", ...rest });
  expect(res.status).toBe(400);
});

test("accepts a prompt of exactly 200 characters", () => {
  const parsed = parseNewInteractionInput("qa", { prompt: "x".repeat(200) }, false);
  expect(parsed.ok).toBe(true);
});

test("PATCH merges qa config on a draft and keeps the rest", async () => {
  const { json } = await create({ type: "qa", prompt: "Ask away" });
  const id = json.interaction.id;
  const bad = await item.PATCH(req("PATCH", { moderation: "strict" }), ctx(eventId, id));
  expect(bad.status).toBe(400);
  const ok = await item.PATCH(req("PATCH", { moderation: "moderated" }), ctx(eventId, id));
  expect(ok.status).toBe(200);
  expect((await ok.json()).interaction).toMatchObject({
    title: "Q&A",
    config: { prompt: "Ask away", moderation: "moderated" },
  });
});

test("duplicating a qa interaction copies its config and none of its questions", async () => {
  const { json } = await create({ type: "qa", title: "Town hall", moderation: "moderated" });
  const source = json.interaction;
  const [p] = await db.insert(participants).values({ eventId }).returning();
  await db.insert(questions).values({ eventId, interactionId: source.id, participantId: p.id, text: "Why?", status: "approved" });

  const res = await duplicate.POST(req("POST"), ctx(eventId, source.id));
  expect(res.status).toBe(201);
  const copy = (await res.json()).interaction;
  expect(copy).toMatchObject({ type: "qa", title: "Town hall", state: "draft", config: source.config });
  expect(copy.id).not.toBe(source.id);
  expect(await db.select().from(questions).where(eq(questions.interactionId, copy.id))).toHaveLength(0);
  expect(await db.select().from(questions).where(eq(questions.interactionId, source.id))).toHaveLength(1);
});

test("ensureQaInteraction creates one paused Q&A per event and reuses it", async () => {
  const [live] = await db
    .insert(interactions)
    .values({ eventId, type: "poll", title: "P", state: "live", position: 0, config: {} })
    .returning();
  const first = await ensureQaInteraction(db, eventId);
  const second = await ensureQaInteraction(db, eventId);
  expect(second).toBe(first);
  const [qa] = await db.select().from(interactions).where(eq(interactions.id, first));
  expect(qa).toMatchObject({ type: "qa", title: "Q&A", state: "paused", position: 1 });
  expect((await db.select().from(interactions).where(eq(interactions.id, live.id)))[0].state).toBe("live");
});

test("ensureQaInteraction copies the event moderation mode and survives parallel calls", async () => {
  await db.update(events).set({ moderationMode: "moderated" }).where(eq(events.id, eventId));
  const ids = await Promise.all([1, 2, 3, 4].map(() => ensureQaInteraction(db, eventId)));
  expect(new Set(ids).size).toBe(1);
  const rows = await db.select().from(interactions).where(eq(interactions.eventId, eventId));
  expect(rows).toHaveLength(1);
  expect(rows[0].config).toMatchObject({ moderation: "moderated" });
});

test("deleting the event removes its questions and votes", async () => {
  const qa = await qaFor(db, eventId);
  const [p] = await db.insert(participants).values({ eventId }).returning();
  const [q] = await db
    .insert(questions)
    .values({ eventId, interactionId: qa, participantId: p.id, text: "Why?", status: "approved" })
    .returning();
  await db.insert(questionVotes).values({ questionId: q.id, participantId: p.id });
  await db.delete(events).where(eq(events.id, eventId));
  expect(await db.select().from(questions)).toHaveLength(0);
  expect(await db.select().from(questionVotes)).toHaveLength(0);
});

test("deleting the Q&A interaction removes its questions and votes but not other Q&As", async () => {
  const qa = await qaFor(db, eventId);
  const [other] = await db
    .insert(interactions)
    .values({ eventId, type: "qa", title: "Second", state: "draft", position: 5, config: {} })
    .returning();
  const [p] = await db.insert(participants).values({ eventId }).returning();
  const [q] = await db
    .insert(questions)
    .values({ eventId, interactionId: qa, participantId: p.id, text: "Gone", status: "approved" })
    .returning();
  await db.insert(questionVotes).values({ questionId: q.id, participantId: p.id });
  await db.insert(questions).values({ eventId, interactionId: other.id, participantId: p.id, text: "Stays", status: "approved" });

  await db.delete(interactions).where(eq(interactions.id, qa));
  expect((await db.select().from(questions)).map((r) => r.text)).toEqual(["Stays"]);
  expect(await db.select().from(questionVotes)).toHaveLength(0);
});

test("the database refuses a question without an interaction or with an unknown type", async () => {
  const [p] = await db.insert(participants).values({ eventId }).returning();
  await expect(
    pool.query(`insert into questions (event_id, participant_id, text, status) values ($1, $2, 'x', 'approved')`, [eventId, p.id]),
  ).rejects.toThrow();
  await expect(
    pool.query(`insert into interactions (event_id, type, title, position) values ($1, 'bogus', 't', 9)`, [eventId]),
  ).rejects.toThrow();
});

// CREATE DATABASE is not allowed for the test role, so the rehearsal runs in its own schema (as in workspaces.test.ts).
test("migration 0031 moves questions under Q&A interactions on seeded data, and the down SQL reverses it", async () => {
  const schema = "mig_rehearsal_qa";
  const files = readMigrationFiles({ migrationsFolder: path.resolve("db/migrations") });
  const names = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
  const idx = names.findIndex((f) => f.startsWith("0031_"));
  expect(idx).toBeGreaterThan(0);

  const rehearsal = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const run = async (migration: (typeof files)[number]) => {
    for (const statement of migration.sql) await rehearsal.query(statement.replaceAll('"public".', `"${schema}".`));
  };
  const U = "00000000-0000-0000-0000-000000000001";
  const W = "00000000-0000-0000-0000-0000000000a1";
  const ev = (n: number) => `10000000-0000-0000-0000-00000000000${n}`;
  // A: moderated, has questions and a live poll. B: questions, no interactions. C: nothing at all.
  // D: no questions, one draft poll. E: questions and only a paused word cloud.
  try {
    await rehearsal.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await rehearsal.query(`CREATE SCHEMA ${schema}`);
    for (const m of files.slice(0, idx)) await run(m);

    await rehearsal.query(`insert into users (id, email, password_hash) values ('${U}', 'a@example.com', 'h')`);
    await rehearsal.query(`insert into workspaces (id, name) values ('${W}', 'w')`);
    await rehearsal.query(
      `insert into events (id, owner_id, workspace_id, name, starts_at, ends_at, join_code, moderation_mode) values
        ('${ev(1)}', '${U}', '${W}', 'A', now(), now(), '1111', 'moderated'),
        ('${ev(2)}', '${U}', '${W}', 'B', now(), now(), '2222', 'open'),
        ('${ev(3)}', '${U}', '${W}', 'C', now(), now(), '3333', 'open'),
        ('${ev(4)}', '${U}', '${W}', 'D', now(), now(), '4444', 'open'),
        ('${ev(5)}', '${U}', '${W}', 'E', now(), now(), '5555', 'moderated')`,
    );
    await rehearsal.query(
      `insert into interactions (event_id, type, title, state, position, config) values
        ('${ev(1)}', 'poll', 'Live poll', 'live', 0, '{}'),
        ('${ev(1)}', 'poll', 'Draft poll', 'draft', 1, '{}'),
        ('${ev(4)}', 'poll', 'Draft', 'draft', 0, '{}'),
        ('${ev(5)}', 'wordcloud', 'Paused cloud', 'paused', 3, '{}')`,
    );
    const eventsWithQuestions = [1, 2, 5];
    for (const n of eventsWithQuestions) {
      for (let i = 0; i < 3; i++) {
        const pid = `20000000-0000-0000-0000-0000000000${n}${i}`;
        await rehearsal.query(`insert into participants (id, event_id) values ($1, $2)`, [pid, ev(n)]);
        const status = i === 2 ? "pending" : "approved";
        await rehearsal.query(
          `insert into questions (id, event_id, participant_id, text, author_name, status, answered, pinned) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [`30000000-0000-0000-0000-0000000000${n}${i}`, ev(n), pid, `Q${n}${i}`, i === 0 ? "Ana" : null, status, i === 1, i === 0],
        );
      }
      // Each participant votes for the first question of their event.
      for (let i = 1; i < 3; i++) {
        await rehearsal.query(`insert into question_votes (question_id, participant_id) values ($1, $2)`, [
          `30000000-0000-0000-0000-0000000000${n}0`,
          `20000000-0000-0000-0000-0000000000${n}${i}`,
        ]);
      }
    }

    const snapshot = async () =>
      (
        await rehearsal.query(
          `select q.event_id, count(*)::int as total,
             count(*) filter (where q.status = 'approved')::int as approved,
             count(*) filter (where q.pinned)::int as pinned,
             count(*) filter (where q.answered)::int as answered,
             (select count(*)::int from question_votes v join questions q2 on q2.id = v.question_id where q2.event_id = q.event_id) as votes
           from questions q group by q.event_id order by q.event_id`,
        )
      ).rows;
    const before = await snapshot();
    expect(before).toHaveLength(3);

    await run(files[idx]);

    expect(await snapshot()).toEqual(before);

    const qa = await rehearsal.query(
      `select event_id, title, state, position, config from interactions where type = 'qa' order by event_id`,
    );
    expect(qa.rows).toEqual([
      { event_id: ev(1), title: "Q&A", state: "paused", position: 2, config: { prompt: "Ask a question", moderation: "moderated" } },
      { event_id: ev(2), title: "Q&A", state: "live", position: 0, config: { prompt: "Ask a question", moderation: "open" } },
      { event_id: ev(3), title: "Q&A", state: "live", position: 0, config: { prompt: "Ask a question", moderation: "open" } },
      { event_id: ev(5), title: "Q&A", state: "live", position: 4, config: { prompt: "Ask a question", moderation: "moderated" } },
    ]);
    const attached = await rehearsal.query(
      `select count(*)::int as n from questions q join interactions i on i.id = q.interaction_id
       where i.event_id = q.event_id and i.type = 'qa'`,
    );
    expect(attached.rows[0].n).toBe(9);
    const oneLive = await rehearsal.query(
      `select event_id, count(*)::int as n from interactions where state = 'live' group by event_id having count(*) > 1`,
    );
    expect(oneLive.rows).toEqual([]);
    const nullable = await rehearsal.query(
      `select is_nullable from information_schema.columns
       where table_schema = $1 and table_name = 'questions' and column_name = 'interaction_id'`,
      [schema],
    );
    expect(nullable.rows[0].is_nullable).toBe("NO");

    // Deleting a Q&A interaction takes its questions and their votes with it.
    await rehearsal.query(`delete from interactions where event_id = '${ev(2)}' and type = 'qa'`);
    expect((await rehearsal.query(`select count(*)::int as n from questions where event_id = '${ev(2)}'`)).rows[0].n).toBe(0);
    expect((await rehearsal.query(`select count(*)::int as n from question_votes`)).rows[0].n).toBe(4);

    // The down SQL puts the old shape back: questions stay on their event, Q&A interactions go.
    await rehearsal.query(readFileSync("db/migrations-down/0031_qa_interactions.down.sql", "utf8"));
    const after = await snapshot();
    expect(after.map((r) => r.event_id)).toEqual([ev(1), ev(5)]);
    expect(after).toEqual(before.filter((r) => r.event_id !== ev(2)));
    expect((await rehearsal.query(`select count(*)::int as n from interactions where type = 'qa'`)).rows[0].n).toBe(0);
    const cols = await rehearsal.query(
      `select column_name from information_schema.columns where table_schema = $1 and table_name = 'questions'`,
      [schema],
    );
    expect(cols.rows.map((r) => r.column_name)).not.toContain("interaction_id");
    await expect(
      rehearsal.query(`insert into interactions (event_id, type, title, position) values ('${ev(3)}', 'qa', 't', 1)`),
    ).rejects.toThrow();
  } finally {
    await rehearsal.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await rehearsal.end();
  }
}, 60_000);
