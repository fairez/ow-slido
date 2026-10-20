// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { aiCalls, events, interactions, noteAnalyses, participants, sharedNotes, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { assertReportFormat, PlanLimitError } from "@/lib/limits";
import { participantSetCookie } from "@/lib/participant-token";
import { PLANS, type PlanLimits } from "@/lib/plans";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;
let join: (req: Request) => Promise<Response>;
let analyze: Handler;
let exportCsv: Handler;
let session: typeof import("@/lib/auth/session");
let noteLib: typeof import("@/lib/note-analysis");
const passwordHash = hashPassword("correct horse battery");

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  join = (await import("@/app/api/join/route")).POST;
  analyze = (await import("@/app/api/interactions/[id]/analyze/route")).POST;
  exportCsv = (await import("@/app/api/events/[id]/export.csv/route")).GET;
  session = await import("@/lib/auth/session");
  noteLib = await import("@/lib/note-analysis");
});
beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

// The tiers are plain data; tests narrow one limit for a single case and put it back.
const free = PLANS.free as { -readonly [K in keyof PlanLimits]: PlanLimits[K] };
const pro = PLANS.pro as { -readonly [K in keyof PlanLimits]: PlanLimits[K] };
const original = { free: { ...PLANS.free }, pro: { ...PLANS.pro } };
afterEach(() => {
  Object.assign(free, original.free);
  Object.assign(pro, original.pro);
  noteLib.setAnalysisRunner(null);
});

const req = (method: string, path: string, cookie?: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-real-ip": "10.0.0.1", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

let codeCounter = 0;
async function makeHost(email: string) {
  const [user] = await db.insert(users).values({ email, passwordHash: await passwordHash }).returning();
  const workspace = await createPersonalWorkspace(db, user);
  const cookie = `session=${session.createSessionToken(user.id)}`;
  const makeEvent = async () => {
    const [event] = await db
      .insert(events)
      .values({
        workspaceId: workspace.id,
        ownerId: user.id,
        createdBy: user.id,
        name: "Town hall",
        joinCode: String(100000 + codeCounter++),
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    return event;
  };
  return { user, workspaceId: workspace.id, cookie, makeEvent };
}

const call = (code: string, cookie?: string) => join(req("POST", "/api/join", cookie, { code }));
const addParticipants = (eventId: string, n: number) =>
  db.insert(participants).values(Array.from({ length: n }, () => ({ eventId }))).returning();
const countParticipants = async (eventId: string) =>
  (await db.select().from(participants).where(eq(participants.eventId, eventId))).length;

// --- participants per event ---

test("a join under the cap creates a participant", async () => {
  const host = await makeHost("host@example.com");
  const event = await host.makeEvent();
  free.participantsPerEvent = 2;
  await addParticipants(event.id, 1);
  expect((await call(event.joinCode)).status).toBe(200);
  expect(await countParticipants(event.id)).toBe(2);
});

test("a join beyond the cap is refused with a message and creates nobody", async () => {
  const host = await makeHost("host@example.com");
  const event = await host.makeEvent();
  free.participantsPerEvent = 2;
  await addParticipants(event.id, 2);

  const denied = await call(event.joinCode);
  expect(denied.status).toBe(403);
  const body = await denied.json();
  expect(body.reason).toBe("participant_limit");
  expect(body.error).toBe("This event is full. Ask the host to let more people in.");
  expect(body).not.toHaveProperty("requiredPlan");
  expect(denied.headers.get("set-cookie")).toBeNull();
  expect(await countParticipants(event.id)).toBe(2);
});

test("the cap message follows the language cookie", async () => {
  const host = await makeHost("host@example.com");
  const event = await host.makeEvent();
  free.participantsPerEvent = 1;
  await addParticipants(event.id, 1);
  const denied = await call(event.joinCode, "lang=id");
  expect((await denied.json()).error).toMatch(/penuh/);
});

test("a participant at the cap can still rejoin with their token", async () => {
  const host = await makeHost("host@example.com");
  const event = await host.makeEvent();
  free.participantsPerEvent = 2;
  const [first] = await addParticipants(event.id, 2);
  const cookie = participantSetCookie(event.id, first.id, false).split(";")[0];

  const again = await call(event.joinCode, cookie);
  expect(again.status).toBe(200);
  expect((await again.json()).participant.id).toBe(first.id);
  expect(await countParticipants(event.id)).toBe(2);
});

test("a higher tier lifts the cap, and each event has its own count", async () => {
  const host = await makeHost("host@example.com");
  const event = await host.makeEvent();
  const other = await host.makeEvent();
  free.participantsPerEvent = 2;
  await addParticipants(event.id, 2);
  expect((await call(event.joinCode)).status).toBe(403);
  expect((await call(other.joinCode)).status).toBe(200);

  await setPlan(db, host.workspaceId, "pro");
  expect((await call(event.joinCode)).status).toBe(200);
  expect(await countParticipants(event.id)).toBe(3);
});

test("simultaneous joins cannot pass the cap", async () => {
  const host = await makeHost("host@example.com");
  const event = await host.makeEvent();
  free.participantsPerEvent = 3;
  const results = await Promise.all(Array.from({ length: 8 }, () => call(event.joinCode)));
  expect(results.filter((r) => r.status === 200)).toHaveLength(3);
  expect(results.filter((r) => r.status === 403)).toHaveLength(5);
  expect(await countParticipants(event.id)).toBe(3);
});

// --- AI calls ---

async function notesFor(host: Awaited<ReturnType<typeof makeHost>>) {
  const event = await host.makeEvent();
  const [notes] = await db
    .insert(interactions)
    .values({ eventId: event.id, type: "sharedNotes", title: "Thoughts?", position: 0, state: "live", config: {} })
    .returning();
  const [participant] = await db.insert(participants).values({ eventId: event.id }).returning();
  await db.insert(sharedNotes).values({ interactionId: notes.id, participantId: participant.id, text: "one", status: "approved" });
  return { event, notes };
}
const start = (host: { cookie: string }, interactionId: string) =>
  analyze(req("POST", "/api/analyze", host.cookie, { acceptNotice: true }), ctx(interactionId));
const recordCalls = (eventId: string | null, n: number, createdAt = new Date()) =>
  db.insert(aiCalls).values(Array.from({ length: n }, () => ({ eventId, kind: "note_analysis", provider: "mock", model: "m", createdAt })));

function allowAnalysis() {
  noteLib.setAnalysisRunner(async () => ({
    summary: "S",
    categories: [{ name: "A", noteIds: [] }],
    keywords: [{ word: "w", weight: 1 }],
    model: "m",
    promptVersion: "v1",
  }));
}
const analysisDone = (interactionId: string) =>
  vi.waitFor(async () => {
    const rows = await db.select().from(noteAnalyses).where(eq(noteAnalyses.interactionId, interactionId));
    expect(rows[0]?.status).toBe("done");
  });

test("Free has no AI calls: starting an analysis returns 402 and changes nothing", async () => {
  const host = await makeHost("host@example.com");
  const { event, notes } = await notesFor(host);
  allowAnalysis();

  const denied = await start(host, notes.id);
  expect(denied.status).toBe(402);
  const body = await denied.json();
  expect(body).toMatchObject({ reason: "ai_event_limit", requiredPlan: "pro" });
  expect(body.error).toMatch(/not part of your plan/);
  expect(await db.select().from(noteAnalyses)).toHaveLength(0);
  const [row] = await db.select().from(events).where(eq(events.id, event.id));
  expect(row.aiNoticeAcceptedAt).toBeNull();
});

test("Pro can start an analysis", async () => {
  const host = await makeHost("host@example.com");
  const { notes } = await notesFor(host);
  await setPlan(db, host.workspaceId, "pro");
  allowAnalysis();

  const ok = await start(host, notes.id);
  expect(ok.status).toBe(202);
  await analysisDone(notes.id);
});

test("an event that used its AI calls is refused, and another event is not", async () => {
  const host = await makeHost("host@example.com");
  const full = await notesFor(host);
  const fresh = await notesFor(host);
  await setPlan(db, host.workspaceId, "pro");
  allowAnalysis();
  pro.aiCallsPerEvent = 2;
  await recordCalls(full.event.id, 2);

  const denied = await start(host, full.notes.id);
  expect(denied.status).toBe(402);
  expect(await denied.json()).toMatchObject({ reason: "ai_event_limit", requiredPlan: "team" });

  expect((await start(host, fresh.notes.id)).status).toBe(202);
  await analysisDone(fresh.notes.id);
});

test("the monthly AI budget counts this workspace's events this month only", async () => {
  const host = await makeHost("host@example.com");
  const target = await notesFor(host);
  const busy = await host.makeEvent();
  const stranger = await makeHost("stranger@example.com");
  const strangerEvent = await stranger.makeEvent();
  await setPlan(db, host.workspaceId, "pro");
  allowAnalysis();
  pro.aiCallsPerMonth = 3;

  const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15));
  await recordCalls(busy.id, 5, lastMonth);
  await recordCalls(strangerEvent.id, 5);
  await recordCalls(busy.id, 2);

  expect((await start(host, target.notes.id)).status).toBe(202);
  await analysisDone(target.notes.id);

  await recordCalls(busy.id, 1);
  await db.delete(noteAnalyses);
  const denied = await start(host, target.notes.id);
  expect(denied.status).toBe(402);
  expect(await denied.json()).toMatchObject({ reason: "ai_month_limit", requiredPlan: "team" });
});

// --- report format ---

test("CSV export works on Free", async () => {
  const host = await makeHost("host@example.com");
  const event = await host.makeEvent();
  const res = await exportCsv(req("GET", "/api/export", host.cookie), ctx(event.id));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/csv");
});

test("export is refused when the tier does not list csv, and the answer names the plan that does", async () => {
  const host = await makeHost("host@example.com");
  const event = await host.makeEvent();
  free.reportFormats = [];
  const denied = await exportCsv(req("GET", "/api/export", host.cookie), ctx(event.id));
  expect(denied.status).toBe(402);
  expect(await denied.json()).toMatchObject({ reason: "report_format", requiredPlan: "pro" });

  await setPlan(db, host.workspaceId, "pro");
  expect((await exportCsv(req("GET", "/api/export", host.cookie), ctx(event.id))).status).toBe(200);
});

test("pdf and xlsx are checked by the same helper once they exist", async () => {
  const host = await makeHost("host@example.com");
  await expect(assertReportFormat(host.workspaceId, "pdf", db)).rejects.toMatchObject({
    reason: "report_format",
    requiredPlan: "pro",
  });
  await expect(assertReportFormat(host.workspaceId, "pdf", db)).rejects.toBeInstanceOf(PlanLimitError);
  await expect(assertReportFormat(host.workspaceId, "csv", db)).resolves.toBeUndefined();
  await setPlan(db, host.workspaceId, "pro");
  await expect(assertReportFormat(host.workspaceId, "xlsx", db)).resolves.toBeUndefined();
});
