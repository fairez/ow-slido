// @vitest-environment node
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, events, memberships, participants, users } from "@/db/schema";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth/session";
import { MemoryLeaderboardStore, getLeaderboardStore, setLeaderboardStore } from "@/lib/leaderboard";
import { PARTICIPANT_DATA_TABLES } from "@/lib/participant-data";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";
import { seedFullEvent } from "./helpers/seed-event";

const { db, pool } = createTestDb();

type Ctx<P> = { params: Promise<P> };
let eraseRoute: (req: Request, ctx: Ctx<{ id: string; participantId: string }>) => Promise<Response>;
let listRoute: (req: Request, ctx: Ctx<{ id: string }>) => Promise<Response>;
let deleteEvent: (req: Request, ctx: Ctx<{ id: string }>) => Promise<Response>;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  eraseRoute = (await import("@/app/api/events/[id]/participants/[participantId]/data/route")).DELETE;
  listRoute = (await import("@/app/api/events/[id]/participants/route")).GET;
  deleteEvent = (await import("@/app/api/events/[id]/route")).DELETE;
});

beforeEach(async () => {
  await truncateAll(db);
  setLeaderboardStore(new MemoryLeaderboardStore());
});
afterAll(async () => {
  setLeaderboardStore(null);
  await pool.end();
});

const request = (method: string, cookie: string) =>
  new Request("http://localhost/x", { method, headers: { cookie, "x-real-ip": "203.0.113.9" } });

async function makeUser(email: string) {
  const [user] = await db.insert(users).values({ email, passwordHash: "x", emailVerifiedAt: new Date() }).returning();
  const workspace = await createPersonalWorkspace(db, user);
  await setPlan(db, workspace.id, "team");
  return { user, workspaceId: workspace.id, cookie: `${SESSION_COOKIE}=${createSessionToken(user.id)}` };
}

async function setup() {
  const owner = await makeUser("owner@example.com");
  const seeded = await seedFullEvent(db, owner.workspaceId, owner.user.id);
  return { owner, ...seeded };
}

const count = async (table: string, where = sql`true`) => {
  const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(`"${table}"`)} where ${where}`);
  return rows[0].n;
};
const countFor = (table: string, participantId: string) => count(table, sql`participant_id = ${participantId}`);

describe("DELETE /api/events/[id]/participants/[participantId]/data", () => {
  it("clears every participant-linked table for that participant and leaves the other one alone", async () => {
    const { owner, event, a, b } = await setup();
    for (const table of PARTICIPANT_DATA_TABLES) {
      expect(await countFor(table, a.id), `${table} seeded for a`).toBeGreaterThan(0);
      expect(await countFor(table, b.id), `${table} seeded for b`).toBeGreaterThan(0);
    }
    const before = Object.fromEntries(await Promise.all(PARTICIPANT_DATA_TABLES.map(async (t) => [t, await countFor(t, b.id)])));

    const res = await eraseRoute(request("DELETE", owner.cookie), { params: Promise.resolve({ id: event.id, participantId: a.id }) });
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(11);

    // B's votes on A's question and note go with them; everything else of B stays.
    const votesOnA = ["question_votes", "shared_note_votes"];
    for (const table of PARTICIPANT_DATA_TABLES) {
      expect(await countFor(table, a.id), `${table} cleared for a`).toBe(0);
      expect(await countFor(table, b.id), `${table} for b`).toBe(votesOnA.includes(table) ? 0 : before[table]);
    }
    expect(await count("participants", sql`id = ${a.id}`)).toBe(0);
    expect(await count("participants", sql`id = ${b.id}`)).toBe(1);
  });

  it("removes the votes on their question and note, and the votes they cast, so counts stay consistent", async () => {
    const { owner, event, a, mine, theirs } = await setup();
    await eraseRoute(request("DELETE", owner.cookie), { params: Promise.resolve({ id: event.id, participantId: a.id }) });

    expect(await count("questions", sql`id = ${mine.question.id}`)).toBe(0);
    expect(await count("shared_notes", sql`id = ${mine.note.id}`)).toBe(0);
    expect(await count("question_votes", sql`question_id = ${mine.question.id}`)).toBe(0);
    expect(await count("shared_note_votes", sql`note_id = ${mine.note.id}`)).toBe(0);
    // B's own question and note stay, without the vote A had cast on them.
    expect(await count("questions", sql`id = ${theirs.question.id}`)).toBe(1);
    expect(await count("shared_notes", sql`id = ${theirs.note.id}`)).toBe(1);
    expect(await count("question_votes", sql`question_id = ${theirs.question.id}`)).toBe(0);
    expect(await count("shared_note_votes", sql`note_id = ${theirs.note.id}`)).toBe(0);
  });

  it("drops the participant from the live leaderboard", async () => {
    const { owner, event, a, b } = await setup();
    const store = getLeaderboardStore();
    await store.add(event.id, { participantId: a.id, points: 900, elapsedMs: 1000 });
    await store.add(event.id, { participantId: b.id, points: 500, elapsedMs: 1000 });

    await eraseRoute(request("DELETE", owner.cookie), { params: Promise.resolve({ id: event.id, participantId: a.id }) });

    expect(await store.size(event.id)).toBe(1);
    expect(await store.rankOf(event.id, a.id)).toBeNull();
    expect((await store.rankOf(event.id, b.id))?.rank).toBe(1);
  });

  it("is audited with ids and a count, no names or text", async () => {
    const { owner, event, a } = await setup();
    await eraseRoute(request("DELETE", owner.cookie), { params: Promise.resolve({ id: event.id, participantId: a.id }) });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "participant.data_deleted"));
    expect(entry).toMatchObject({
      workspaceId: owner.workspaceId,
      actorLabel: "owner@example.com",
      targetType: "participant",
      targetId: a.id,
      metadata: { eventId: event.id, removedCount: 11 },
    });
    expect(JSON.stringify(entry.metadata)).not.toContain("Ayu");
  });

  it("answers 404 for a participant of another event or an unknown id, and changes nothing", async () => {
    const { owner, event, a } = await setup();
    const other = await seedFullEvent(db, owner.workspaceId, owner.user.id);
    const wrongEvent = await eraseRoute(request("DELETE", owner.cookie), {
      params: Promise.resolve({ id: event.id, participantId: other.a.id }),
    });
    expect(wrongEvent.status).toBe(404);
    const garbage = await eraseRoute(request("DELETE", owner.cookie), { params: Promise.resolve({ id: event.id, participantId: "nope" }) });
    expect(garbage.status).toBe(404);
    expect(await count("participants")).toBe(4);
    expect(await countFor("poll_votes", a.id)).toBe(1);
  });

  it("needs event.edit in the event's own workspace", async () => {
    const { owner, event, a } = await setup();
    const stranger = await makeUser("stranger@example.com");
    const viewer = await makeUser("viewer@example.com");
    await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: viewer.user.id, role: "viewer" });
    const moderator = await makeUser("mod@example.com");
    await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: moderator.user.id, role: "moderator" });
    const params = { params: Promise.resolve({ id: event.id, participantId: a.id }) };

    const anonymous = await eraseRoute(request("DELETE", ""), params);
    expect(anonymous.status).toBe(401);
    // The stranger's active workspace is their own, where this event does not exist.
    expect((await eraseRoute(request("DELETE", stranger.cookie), params)).status).toBe(404);
    for (const member of [viewer, moderator]) {
      const res = await eraseRoute(request("DELETE", `${member.cookie}; workspace=${owner.workspaceId}`), params);
      expect(res.status).toBe(403);
    }
    expect(await count("participants", sql`id = ${a.id}`)).toBe(1);
    expect(await count("audit_log", sql`action = 'participant.data_deleted'`)).toBe(0);
  });

  it("lists participants with a name, contribution count and the total", async () => {
    const { owner, event, a } = await setup();
    await db.insert(participants).values({ eventId: event.id });
    const res = await listRoute(request("GET", owner.cookie), { params: Promise.resolve({ id: event.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(3);
    const byId = new Map(body.participants.map((p: { id: string }) => [p.id, p]));
    expect(byId.get(a.id)).toMatchObject({ name: "Ayu", contributions: 11 });
    const anonymous = body.participants.find((p: { name: string | null }) => p.name === null);
    expect(anonymous.contributions).toBe(0);

    const viewer = await makeUser("viewer@example.com");
    await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: viewer.user.id, role: "viewer" });
    const denied = await listRoute(request("GET", `${viewer.cookie}; workspace=${owner.workspaceId}`), { params: Promise.resolve({ id: event.id }) });
    expect(denied.status).toBe(403);
  });
});

describe("participant-linked tables are all covered", () => {
  it("lists every table with a participant_id column in PARTICIPANT_DATA_TABLES", async () => {
    const { rows } = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'participant_id' order by table_name`);
    expect(rows.map((r) => r.table_name).sort()).toEqual([...PARTICIPANT_DATA_TABLES].sort());
  });
});

describe("deleting an event", () => {
  type Fk = { child: string; parent: string; rule: string };

  /** Every table that reaches `events` through foreign keys, however many hops away. */
  async function tablesReachingEvents() {
    const { rows } = await db.execute<Fk>(sql`
      select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, c.confdeltype::text as rule
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname = 'public'`);
    const reached = new Set<string>();
    const queue = ["events"];
    while (queue.length) {
      const parent = queue.pop()!;
      for (const fk of rows) {
        if (fk.parent === parent && !reached.has(fk.child)) {
          reached.add(fk.child);
          queue.push(fk.child);
        }
      }
    }
    return { reached: [...reached].sort(), edges: rows };
  }

  it("removes everything under the event; only the AI call counter outlives it", async () => {
    const { owner, event } = await setup();
    const { reached, edges } = await tablesReachingEvents();
    // AI calls keep their row (event set to null) so deleting events cannot reset the daily cap.
    const kept = ["ai_calls"];
    const mustEmpty = reached.filter((t) => !kept.includes(t));
    expect(mustEmpty).toContain("quiz_answers");
    expect(mustEmpty).toContain("survey_answers");

    for (const table of mustEmpty) expect(await count(table), `${table} seeded`).toBeGreaterThan(0);
    // Every foreign key on the way down cascades, except the AI call counter's.
    // Links to users or workspaces (who created it) are not event data and may set null.
    const inTree = new Set(["events", ...reached]);
    for (const fk of edges.filter((e) => inTree.has(e.child) && inTree.has(e.parent))) {
      if (kept.includes(fk.child)) continue;
      expect(fk.rule, `${fk.child} -> ${fk.parent}`).toBe("c");
    }

    const res = await deleteEvent(request("DELETE", owner.cookie), { params: Promise.resolve({ id: event.id }) });
    expect(res.status).toBe(204);

    for (const table of mustEmpty) expect(await count(table), `${table} emptied`).toBe(0);
    expect(await count("events", sql`id = ${event.id}`)).toBe(0);
    expect(await count("ai_calls", sql`event_id is not null`)).toBe(0);
    expect(await count("ai_calls")).toBe(1);
  });

  it("writes an audit entry with the event name", async () => {
    const { owner, event } = await setup();
    await deleteEvent(request("DELETE", owner.cookie), { params: Promise.resolve({ id: event.id }) });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "event.deleted"));
    expect(entry).toMatchObject({ targetId: event.id, metadata: { eventName: "Town hall" } });
    expect(await db.select().from(events).where(eq(events.id, event.id))).toHaveLength(0);
  });
});
