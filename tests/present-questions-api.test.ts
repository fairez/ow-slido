// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { participants, questionVotes, questions } from "@/db/schema";
import { createTestDb, qaFor, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
let route: { GET: (r: Request, c: Ctx) => Promise<Response> };
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let signup: (req: Request) => Promise<Response>;
let hostCookie: string;
let otherCookie: string;
let eventId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  route = await import("@/app/api/events/[id]/present/questions/route");
  eventsRoute = await import("@/app/api/events/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
});

const post = (path: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const register = async (email: string) =>
  ((await signup(post("/api/auth/signup", { email, password: "password123" }))).headers.get("set-cookie") ?? "").split(";")[0];
const get = (cookie: string | null, id = eventId) =>
  route.GET(new Request("http://localhost/api", { headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ id }) });

beforeEach(async () => {
  await truncateAll(db);
  hostCookie = await register("host@example.com");
  otherCookie = await register("other@example.com");
  const created = await eventsRoute.POST(
    post("/api/events", { name: "Town hall", startsAt: "2026-11-01T10:00:00Z", endsAt: "2026-11-01T12:00:00Z" }, hostCookie),
  );
  eventId = (await created.json()).event.id;
});

afterAll(() => pool.end());

async function addQuestion(text: string, status: "pending" | "approved" | "rejected", extra: Partial<typeof questions.$inferInsert> = {}) {
  const [p] = await db.insert(participants).values({ eventId }).returning();
  const [row] = await db.insert(questions).values({ eventId, interactionId: await qaFor(db, eventId), participantId: p.id, text, status, ...extra }).returning();
  return { row, participantId: p.id };
}

test("returns approved questions only, with upvotes, pin and answered flags", async () => {
  const a = await addQuestion("Approved one", "approved", { pinned: true });
  await addQuestion("Waiting", "pending");
  await addQuestion("Rejected", "rejected");
  const answered = await addQuestion("Answered", "approved", { answered: true, authorName: "Dewi" });
  const [voter] = await db.insert(participants).values({ eventId }).returning();
  await db.insert(questionVotes).values({ questionId: answered.row.id, participantId: voter.id });

  const res = await get(hostCookie);
  expect(res.status).toBe(200);
  const { questions: list } = await res.json();
  expect(list.map((x: { text: string }) => x.text).sort()).toEqual(["Answered", "Approved one"]);
  expect(list.find((x: { text: string }) => x.text === "Answered")).toMatchObject({ answered: true, authorName: "Dewi", upvotes: 1 });
  expect(list.find((x: { id: string }) => x.id === a.row.id)).toMatchObject({ pinned: true, upvotes: 0 });
  expect(JSON.stringify(list)).not.toMatch(/participantId|status|pending/);
});

test("a question that is hidden again no longer appears", async () => {
  const a = await addQuestion("Soon hidden", "approved");
  expect((await (await get(hostCookie)).json()).questions).toHaveLength(1);
  await db.update(questions).set({ status: "rejected" }).where(eq(questions.id, a.row.id));
  expect((await (await get(hostCookie)).json()).questions).toHaveLength(0);
});

test("needs a login and the owner's event", async () => {
  expect((await get(null)).status).toBe(401);
  expect((await get(otherCookie)).status).toBe(404);
  expect((await get(hostCookie, "11111111-1111-4111-8111-111111111111")).status).toBe(404);
});
