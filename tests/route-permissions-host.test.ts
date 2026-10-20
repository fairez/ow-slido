// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, interactions, memberships, participants, questions, users, workspaces } from "@/db/schema";
import type { Role } from "@/lib/auth/permissions";
import { createTestDb, qaFor, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (request: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let session: typeof import("@/lib/auth/session");
const routes = {} as Record<string, Handler>;

const ROLES: Role[] = ["owner", "admin", "editor", "moderator", "viewer"];
const userIds = {} as Record<Role, string>;
let workspaceId: string;
let eventId: string;
let interactionId: string;
let questionId: string;
let joinCode: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.AI_PROVIDER = "mock";
  session = await import("@/lib/auth/session");
  routes.moderation = (await import("@/app/api/events/[id]/moderation/route")).GET as Handler;
  routes.questionPatch = (await import("@/app/api/events/[id]/questions/[questionId]/route")).PATCH as Handler;
  routes.exportCsv = (await import("@/app/api/events/[id]/export.csv/route")).GET as Handler;
  routes.present = (await import("@/app/api/events/[id]/present/route")).GET as Handler;
  routes.presentQuestions = (await import("@/app/api/events/[id]/present/questions/route")).GET as Handler;
  routes.questionsList = (await import("@/app/api/events/[id]/questions/route")).GET as Handler;
  routes.analysisGet = (await import("@/app/api/interactions/[id]/analysis/route")).GET as Handler;
  routes.analysisPatch = (await import("@/app/api/interactions/[id]/analysis/route")).PATCH as Handler;
  routes.analyze = (await import("@/app/api/interactions/[id]/analyze/route")).POST as Handler;
  routes.aiTest = (await import("@/app/api/ai/test/route")).POST as Handler;
  routes.responsePatch = (await import("@/app/api/responses/[id]/route")).PATCH as Handler;
  routes.join = (await import("@/app/api/join/route")).POST as Handler;
});
afterAll(() => pool.end());

beforeEach(async () => {
  await truncateAll(db);
  const [ws] = await db.insert(workspaces).values({ name: "W" }).returning();
  workspaceId = ws.id;
  for (const role of ROLES) {
    const [u] = await db.insert(users).values({ email: `${role}@example.com`, passwordHash: "x" }).returning();
    userIds[role] = u.id;
    await db.insert(memberships).values({ workspaceId, userId: u.id, role });
  }
  joinCode = String(100000 + Math.floor(Math.random() * 899999));
  const [event] = await db
    .insert(events)
    .values({
      workspaceId,
      ownerId: userIds.owner,
      createdBy: userIds.owner,
      name: "E",
      joinCode,
      startsAt: new Date("2026-01-01"),
      endsAt: new Date("2026-01-02"),
    })
    .returning();
  eventId = event.id;
  const [interaction] = await db
    .insert(interactions)
    .values({ eventId, type: "sharedNotes", title: "N", position: 0, state: "live", config: {} })
    .returning();
  interactionId = interaction.id;
  const [participant] = await db.insert(participants).values({ eventId }).returning();
  const [question] = await db
    .insert(questions)
    .values({ eventId, interactionId: await qaFor(db, eventId), participantId: participant.id, text: "Why?", status: "pending" })
    .returning();
  questionId = question.id;
});

const req = (userId: string | null, body?: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(userId ? { cookie: `${session.SESSION_COOKIE}=${session.createSessionToken(userId)}; workspace=${workspaceId}` } : {}),
    },
  });
const ctx = () => ({ params: Promise.resolve({ id: eventId, questionId }) });
const ictx = () => ({ params: Promise.resolve({ id: interactionId }) });

const GROUPS: { name: string; allowed: Role[]; call: (userId: string | null) => Promise<Response> }[] = [
  {
    name: "moderate (queue read)",
    allowed: ["owner", "admin", "editor", "moderator"],
    call: (u) => routes.moderation(req(u), ctx()),
  },
  {
    name: "moderate (question approve)",
    allowed: ["owner", "admin", "editor", "moderator"],
    call: (u) => routes.questionPatch(req(u, { status: "approved" }), ctx()),
  },
  {
    name: "moderate (open text response)",
    allowed: ["owner", "admin", "editor", "moderator"],
    call: (u) => routes.responsePatch(req(u, { hidden: true }), { params: Promise.resolve({ id: questionId }) }),
  },
  { name: "export", allowed: ["owner", "admin", "editor", "viewer"], call: (u) => routes.exportCsv(req(u), ctx()) },
  { name: "insights (start analysis)", allowed: ["owner", "admin", "editor"], call: (u) => routes.analyze(req(u, { acceptNotice: true }), ictx()) },
  { name: "insights (publish)", allowed: ["owner", "admin", "editor"], call: (u) => routes.analysisPatch(req(u, { published: true }), ictx()) },
  { name: "insights (AI test)", allowed: ["owner", "admin", "editor"], call: (u) => routes.aiTest(req(u), ctx()) },
  { name: "results (analysis read)", allowed: ROLES, call: (u) => routes.analysisGet(req(u), ictx()) },
  { name: "results (presenter state)", allowed: ROLES, call: (u) => routes.present(req(u), ctx()) },
  { name: "results (presenter questions)", allowed: ROLES, call: (u) => routes.presentQuestions(req(u), ctx()) },
];

for (const group of GROUPS) {
  for (const role of ROLES) {
    test(`${group.name}: ${role}`, async () => {
      const res = await group.call(userIds[role]);
      if (group.allowed.includes(role)) {
        expect([401, 403]).not.toContain(res.status);
      } else {
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBeTruthy();
      }
    });
  }
  test(`${group.name}: anonymous gets 401`, async () => {
    const res = await group.call(null);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });
}

test("audience can join without a login", async () => {
  const res = await routes.join(req(null, { code: joinCode }), ctx());
  expect(res.status).toBe(200);
});

test("audience cannot read the host question list: a viewer-less caller gets 401", async () => {
  const res = await routes.questionsList(req(null), ctx());
  expect(res.status).toBe(401);
});
