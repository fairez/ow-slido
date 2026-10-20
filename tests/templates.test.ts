// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  events,
  interactions,
  memberships,
  participants,
  pollVotes,
  questions,
  sharedNotes,
  templateItems,
  templates,
  users,
  workspaces,
} from "@/db/schema";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<Record<string, string>> };
type Handlers = Record<string, (r: Request, c: Ctx) => Promise<Response>>;
let templatesRoute: Handlers;
let templateRoute: Handlers;
let fromTemplateRoute: Handlers;
let addRoute: Handlers;
let newEventRoute: Handlers;
let session: typeof import("@/lib/auth/session");

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  templatesRoute = (await import("@/app/api/templates/route")) as unknown as Handlers;
  templateRoute = (await import("@/app/api/templates/[id]/route")) as unknown as Handlers;
  fromTemplateRoute = (await import("@/app/api/events/from-template/route")) as unknown as Handlers;
  addRoute = (await import("@/app/api/events/[id]/interactions/from-template/route")) as unknown as Handlers;
  newEventRoute = (await import("@/app/api/events/route")) as unknown as Handlers;
  session = await import("@/lib/auth/session");
});
beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

const req = (method: string, cookie: string, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", cookie, "x-real-ip": "10.0.0.1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (params: Record<string, string>): Ctx => ({ params: Promise.resolve(params) });
const eventBody = { name: "From template", startsAt: "2030-01-01T10:00:00Z", endsAt: "2030-01-01T12:00:00Z" };

async function makeUser(email: string) {
  const [user] = await db.insert(users).values({ email, passwordHash: "x" }).returning();
  const workspace = await createPersonalWorkspace(db, user);
  return { user, workspaceId: workspace.id, cookie: `${session.SESSION_COOKIE}=${session.createSessionToken(user.id)}` };
}

/** A member of `workspaceId` with `role`, acting through the workspace cookie. */
async function makeMember(workspaceId: string, role: "admin" | "editor" | "viewer") {
  const [user] = await db.insert(users).values({ email: `${role}@example.com`, passwordHash: "x" }).returning();
  await db.insert(memberships).values({ workspaceId, userId: user.id, role });
  return `${session.SESSION_COOKIE}=${session.createSessionToken(user.id)}; workspace=${workspaceId}`;
}

let joinCounter = 100000;
async function makeEvent(owner: { user: { id: string }; workspaceId: string }, name = "Workshop") {
  const [event] = await db
    .insert(events)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.user.id,
      name,
      joinCode: String(joinCounter++),
      startsAt: new Date("2030-01-01T10:00:00Z"),
      endsAt: new Date("2030-01-01T12:00:00Z"),
    })
    .returning();
  return event;
}

/** An event with a live poll (that has a vote), a Q&A (that has a question), shared notes (with a note) and a word cloud. */
async function seedEvent(owner: { user: { id: string }; workspaceId: string }) {
  const event = await makeEvent(owner);
  const [participant] = await db.insert(participants).values({ eventId: event.id }).returning();
  const rows = await db
    .insert(interactions)
    .values([
      {
        eventId: event.id,
        type: "poll",
        title: "Lunch?",
        state: "live",
        position: 0,
        config: { options: [{ id: "a", label: "Rice" }, { id: "b", label: "Noodles" }], multiSelect: true, showResultsToParticipants: true },
      },
      { eventId: event.id, type: "qa", title: "Ask us", state: "paused", position: 1, config: { prompt: "Anything?", moderation: "moderated", profanityFilter: false } },
      { eventId: event.id, type: "sharedNotes", title: "Notes", state: "closed", position: 2, config: { prompt: "Write", maxNotes: 5 } },
      { eventId: event.id, type: "wordcloud", title: "One word", state: "draft", position: 3, config: { prompt: "One word", maxEntriesPerParticipant: 2 } },
    ])
    .returning();
  const [poll, qa, notes] = rows;
  await db.insert(pollVotes).values({ interactionId: poll.id, participantId: participant.id, optionIds: ["a"] });
  await db.insert(questions).values({ eventId: event.id, interactionId: qa.id, participantId: participant.id, text: "Why?", status: "approved" });
  await db.insert(sharedNotes).values({ interactionId: notes.id, participantId: participant.id, text: "secret note", status: "approved" });
  return { event, rows };
}

const save = (cookie: string, body: unknown) => templatesRoute.POST(req("POST", cookie, body), ctx({}));

test("saving one interaction stores only its content", async () => {
  const host = await makeUser("h@example.com");
  const { event, rows } = await seedEvent(host);

  const res = await save(host.cookie, { eventId: event.id, interactionId: rows[0].id, name: "Lunch poll" });
  expect(res.status).toBe(201);
  const { template } = await res.json();
  expect(template).toMatchObject({ name: "Lunch poll", kind: "interaction", workspaceId: host.workspaceId, createdBy: host.user.id });

  const items = await db.select().from(templateItems).where(eq(templateItems.templateId, template.id));
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ type: "poll", title: "Lunch?", position: 0 });
  const config = items[0].config as { options: { label: string }[]; multiSelect: boolean };
  expect(config.options.map((o) => o.label)).toEqual(["Rice", "Noodles"]);
  expect(config.multiSelect).toBe(true);
  // The template has no column for state, votes or participants.
  expect(Object.keys(items[0]).sort()).toEqual(["config", "id", "position", "templateId", "title", "type"]);
  expect(JSON.stringify(items[0])).not.toContain("secret");
});

test("saving a whole event keeps order, defaults the name and skips nothing", async () => {
  const host = await makeUser("h@example.com");
  const { event } = await seedEvent(host);

  const res = await save(host.cookie, { eventId: event.id });
  const { template } = await res.json();
  expect(template).toMatchObject({ name: "Workshop", kind: "event" });
  const items = await db.select().from(templateItems).where(eq(templateItems.templateId, template.id)).orderBy(templateItems.position);
  expect(items.map((i) => [i.position, i.type, i.title])).toEqual([
    [0, "poll", "Lunch?"],
    [1, "qa", "Ask us"],
    [2, "sharedNotes", "Notes"],
    [3, "wordcloud", "One word"],
  ]);
  expect(items[1].config).toMatchObject({ prompt: "Anything?", moderation: "moderated", profanityFilter: false });
});

test("save validates the source and the name", async () => {
  const host = await makeUser("h@example.com");
  const { event } = await seedEvent(host);
  const empty = await makeEvent(host, "Empty");
  const other = await makeUser("o@example.com");
  const foreign = await makeEvent(other);

  expect((await save(host.cookie, {})).status).toBe(400);
  expect((await save(host.cookie, { eventId: foreign.id })).status).toBe(404);
  expect((await save(host.cookie, { eventId: event.id, interactionId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
  expect((await save(host.cookie, { eventId: empty.id })).status).toBe(400);
  expect((await save(host.cookie, { eventId: event.id, name: "  " })).status).toBe(400);
  expect((await save(host.cookie, { eventId: event.id, name: "x".repeat(81) })).status).toBe(400);
  expect(await db.select().from(templates)).toHaveLength(0);
});

test("using a template adds drafts after existing content and never copies responses", async () => {
  const host = await makeUser("h@example.com");
  const { event, rows } = await seedEvent(host);
  const { template } = await (await save(host.cookie, { eventId: event.id })).json();

  const target = await makeEvent(host, "Target");
  await db.insert(interactions).values({ eventId: target.id, type: "openText", title: "Existing", position: 0, config: {} });
  const res = await addRoute.POST(req("POST", host.cookie, { templateId: template.id }), ctx({ id: target.id }));
  expect(res.status).toBe(201);

  const list = await db.select().from(interactions).where(eq(interactions.eventId, target.id)).orderBy(interactions.position);
  expect(list.map((i) => [i.position, i.type, i.title, i.state])).toEqual([
    [0, "openText", "Existing", "draft"],
    [1, "poll", "Lunch?", "draft"],
    [2, "qa", "Ask us", "draft"],
    [3, "sharedNotes", "Notes", "draft"],
    [4, "wordcloud", "One word", "draft"],
  ]);
  expect(list[3].createdBy).toBe(host.user.id);
  expect(list[2].config).toMatchObject({ prompt: "Anything?", moderation: "moderated" });
  // Poll options keep their labels but get new ids.
  const copied = (list[1].config as { options: { id: string; label: string }[] }).options;
  const original = (rows[0].config as { options: { id: string; label: string }[] }).options;
  expect(copied.map((o) => o.label)).toEqual(original.map((o) => o.label));
  expect(copied.map((o) => o.id)).not.toEqual(original.map((o) => o.id));

  const copiedIds = list.map((i) => i.id);
  expect(await db.select().from(pollVotes)).toHaveLength(1);
  expect((await db.select().from(pollVotes))[0].interactionId).toBe(rows[0].id);
  expect((await db.select().from(questions)).every((q) => !copiedIds.includes(q.interactionId))).toBe(true);
  expect((await db.select().from(sharedNotes)).every((n) => !copiedIds.includes(n.interactionId))).toBe(true);
  expect(await db.select().from(participants).where(eq(participants.eventId, target.id))).toHaveLength(0);
});

test("a template can be used twice and survives its source event", async () => {
  const host = await makeUser("h@example.com");
  const { event } = await seedEvent(host);
  const { template } = await (await save(host.cookie, { eventId: event.id })).json();
  await db.delete(events).where(eq(events.id, event.id));

  const target = await makeEvent(host, "Target");
  for (let i = 0; i < 2; i++) {
    expect((await addRoute.POST(req("POST", host.cookie, { templateId: template.id }), ctx({ id: target.id }))).status).toBe(201);
  }
  expect(await db.select().from(interactions).where(eq(interactions.eventId, target.id))).toHaveLength(8);
});

test("an event made from a template carries its items as drafts", async () => {
  const host = await makeUser("h@example.com");
  const { event } = await seedEvent(host);
  const { template } = await (await save(host.cookie, { eventId: event.id, interactionId: undefined })).json();

  const res = await fromTemplateRoute.POST(req("POST", host.cookie, { ...eventBody, templateId: template.id }), ctx({}));
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.skipped).toBe(0);
  expect(body.event).toMatchObject({ name: "From template", workspaceId: host.workspaceId });
  const list = await db.select().from(interactions).where(eq(interactions.eventId, body.event.id)).orderBy(interactions.position);
  expect(list.map((i) => [i.type, i.state])).toEqual([["poll", "draft"], ["qa", "draft"], ["sharedNotes", "draft"], ["wordcloud", "draft"]]);
  expect(await db.select().from(participants).where(eq(participants.eventId, body.event.id))).toHaveLength(0);

  expect((await fromTemplateRoute.POST(req("POST", host.cookie, { ...eventBody, templateId: template.id, name: "" }), ctx({}))).status).toBe(400);
  expect((await fromTemplateRoute.POST(req("POST", host.cookie, eventBody), ctx({}))).status).toBe(404);
});

test("list shows items and usage; rename and delete work", async () => {
  const host = await makeUser("h@example.com");
  const { event, rows } = await seedEvent(host);
  const { template } = await (await save(host.cookie, { eventId: event.id })).json();
  await save(host.cookie, { eventId: event.id, interactionId: rows[1].id });

  const list = await (await templatesRoute.GET(req("GET", host.cookie), ctx({}))).json();
  expect(list.usage).toEqual({ used: 2, limit: 3 });
  expect(list.templates).toHaveLength(2);
  const full = list.templates.find((t: { id: string }) => t.id === template.id);
  expect(full.items.map((i: { type: string }) => i.type)).toEqual(["poll", "qa", "sharedNotes", "wordcloud"]);

  const renamed = await templateRoute.PATCH(req("PATCH", host.cookie, { name: " Renamed " }), ctx({ id: template.id }));
  expect((await renamed.json()).template.name).toBe("Renamed");
  expect((await templateRoute.PATCH(req("PATCH", host.cookie, { name: "" }), ctx({ id: template.id }))).status).toBe(400);

  expect((await templateRoute.DELETE(req("DELETE", host.cookie), ctx({ id: template.id }))).status).toBe(200);
  expect(await db.select().from(templates)).toHaveLength(1);
  expect(await db.select().from(templateItems).where(eq(templateItems.templateId, template.id))).toHaveLength(0);
  expect((await templateRoute.DELETE(req("DELETE", host.cookie), ctx({ id: template.id }))).status).toBe(404);
});

test("the template count follows the plan and answers 402 beyond it", async () => {
  const host = await makeUser("h@example.com");
  const { event } = await seedEvent(host);
  for (let i = 0; i < 3; i++) expect((await save(host.cookie, { eventId: event.id })).status).toBe(201);

  const res = await save(host.cookie, { eventId: event.id });
  expect(res.status).toBe(402);
  expect(await res.json()).toMatchObject({ reason: "template_limit", requiredPlan: "pro" });
  expect(await db.select().from(templates)).toHaveLength(3);

  await setPlan(db, host.workspaceId, "pro");
  expect((await save(host.cookie, { eventId: event.id })).status).toBe(201);

  // Deleting one frees a slot on Free again.
  await setPlan(db, host.workspaceId, "free");
  const [first] = await db.select().from(templates);
  await db.delete(templates).where(eq(templates.id, first.id));
  await db.delete(templates).where(eq(templates.name, "Workshop"));
  expect((await save(host.cookie, { eventId: event.id })).status).toBe(201);
});

test("other workspaces cannot see or use a template", async () => {
  const host = await makeUser("h@example.com");
  const stranger = await makeUser("s@example.com");
  const { event } = await seedEvent(host);
  const { template } = await (await save(host.cookie, { eventId: event.id })).json();
  const strangerEvent = await makeEvent(stranger);

  expect((await (await templatesRoute.GET(req("GET", stranger.cookie), ctx({}))).json()).templates).toEqual([]);
  expect((await templateRoute.PATCH(req("PATCH", stranger.cookie, { name: "x" }), ctx({ id: template.id }))).status).toBe(404);
  expect((await templateRoute.DELETE(req("DELETE", stranger.cookie), ctx({ id: template.id }))).status).toBe(404);
  expect((await addRoute.POST(req("POST", stranger.cookie, { templateId: template.id }), ctx({ id: strangerEvent.id }))).status).toBe(404);
  expect((await fromTemplateRoute.POST(req("POST", stranger.cookie, { ...eventBody, templateId: template.id }), ctx({}))).status).toBe(404);
  expect((await save(stranger.cookie, { eventId: event.id })).status).toBe(404);
  expect(await db.select().from(templates)).toHaveLength(1);
});

test("roles: owners and admins manage, editors use, viewers do neither", async () => {
  const host = await makeUser("h@example.com");
  await setPlan(db, host.workspaceId, "team");
  const admin = await makeMember(host.workspaceId, "admin");
  const editor = await makeMember(host.workspaceId, "editor");
  const viewer = await makeMember(host.workspaceId, "viewer");
  const { event } = await seedEvent(host);

  expect((await save(admin, { eventId: event.id })).status).toBe(201);
  const { template } = await (await save(host.cookie, { eventId: event.id })).json();

  expect((await save(editor, { eventId: event.id })).status).toBe(403);
  expect((await templateRoute.PATCH(req("PATCH", editor, { name: "x" }), ctx({ id: template.id }))).status).toBe(403);
  expect((await templateRoute.DELETE(req("DELETE", editor), ctx({ id: template.id }))).status).toBe(403);
  expect((await templatesRoute.GET(req("GET", editor), ctx({}))).status).toBe(200);
  const target = await makeEvent(host, "Target");
  expect((await addRoute.POST(req("POST", editor, { templateId: template.id }), ctx({ id: target.id }))).status).toBe(201);
  expect((await fromTemplateRoute.POST(req("POST", editor, { ...eventBody, templateId: template.id }), ctx({}))).status).toBe(201);

  expect((await templatesRoute.GET(req("GET", viewer), ctx({}))).status).toBe(200);
  expect((await addRoute.POST(req("POST", viewer, { templateId: template.id }), ctx({ id: target.id }))).status).toBe(403);
  expect((await fromTemplateRoute.POST(req("POST", viewer, { ...eventBody, templateId: template.id }), ctx({}))).status).toBe(403);
  expect((await templateRoute.DELETE(req("DELETE", admin), ctx({ id: template.id }))).status).toBe(200);
});

test("types the plan lacks: adding is refused, a new event leaves them out", async () => {
  const host = await makeUser("h@example.com");
  await setPlan(db, host.workspaceId, "pro");
  const { event } = await seedEvent(host);
  const { template } = await (await save(host.cookie, { eventId: event.id })).json();
  // Free has no type the template lacks yet, so narrow it to Q&A only (restored in finally).
  const { PLANS } = await import("@/lib/plans");
  const free = PLANS.free as { allowedTypes: readonly string[] };
  const original = free.allowedTypes;
  try {
    await setPlan(db, host.workspaceId, "free");
    free.allowedTypes = ["qa"];
    const target = await makeEvent(host, "Target");
    const add = await addRoute.POST(req("POST", host.cookie, { templateId: template.id }), ctx({ id: target.id }));
    expect(add.status).toBe(402);
    expect(await add.json()).toMatchObject({ reason: "type_not_allowed" });
    expect(await db.select().from(interactions).where(eq(interactions.eventId, target.id))).toHaveLength(0);

    const created = await fromTemplateRoute.POST(req("POST", host.cookie, { ...eventBody, templateId: template.id }), ctx({}));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.skipped).toBe(3);
  } finally {
    free.allowedTypes = original;
  }
});

test("creating from a template follows the monthly event limit", async () => {
  const host = await makeUser("h@example.com");
  const { event } = await seedEvent(host);
  const { template } = await (await save(host.cookie, { eventId: event.id })).json();
  // Free allows 3 events a month; the seeded one is the first.
  expect((await newEventRoute.POST(req("POST", host.cookie, eventBody), ctx({}))).status).toBe(201);
  expect((await fromTemplateRoute.POST(req("POST", host.cookie, { ...eventBody, templateId: template.id }), ctx({}))).status).toBe(201);
  const res = await fromTemplateRoute.POST(req("POST", host.cookie, { ...eventBody, templateId: template.id }), ctx({}));
  expect(res.status).toBe(402);
  expect(await res.json()).toMatchObject({ reason: "event_limit" });
});

test("deleting a workspace removes its templates and items; deleting a template keeps the source", async () => {
  const host = await makeUser("h@example.com");
  const { event } = await seedEvent(host);
  await save(host.cookie, { eventId: event.id });
  expect(await db.select().from(templateItems)).toHaveLength(4);

  const [template] = await db.select().from(templates);
  await db.delete(templates).where(eq(templates.id, template.id));
  expect(await db.select().from(templateItems)).toHaveLength(0);
  expect(await db.select().from(interactions).where(eq(interactions.eventId, event.id))).toHaveLength(4);

  await save(host.cookie, { eventId: event.id });
  await db.delete(workspaces).where(eq(workspaces.id, host.workspaceId));
  expect(await db.select().from(templates)).toHaveLength(0);
  expect(await db.select().from(templateItems)).toHaveLength(0);
});

test("a deleted creator leaves the template in place", async () => {
  const host = await makeUser("h@example.com");
  const { event } = await seedEvent(host);
  await save(host.cookie, { eventId: event.id });
  await db.delete(memberships).where(eq(memberships.userId, host.user.id));
  await db.delete(users).where(eq(users.id, host.user.id));
  const rows = await db.select().from(templates);
  expect(rows).toHaveLength(1);
  expect(rows[0].createdBy).toBeNull();
});
