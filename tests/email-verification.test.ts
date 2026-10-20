// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { authTokens, events, interactions, memberships, users, workspaces } from "@/db/schema";
import { clearOutbox, getOutbox } from "@/lib/email";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request, ctx?: never) => Promise<Response>;
let signup: Handler;
let resend: Handler;
let start: (req: Request, ctx: { params: Promise<{ id: string; interactionId: string }> }) => Promise<Response>;
let verifyEmailToken: typeof import("@/lib/auth/verification").verifyEmailToken;
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  signup = (await import("@/app/api/auth/signup/route")).POST;
  resend = (await import("@/app/api/auth/verify/resend/route")).POST;
  start = (await import("@/app/api/events/[id]/interactions/[interactionId]/start/route")).POST;
  verifyEmailToken = (await import("@/lib/auth/verification")).verifyEmailToken;
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  clearOutbox();
  delete process.env.ALLOW_SIGNUP;
});
afterAll(() => pool.end());

const post = (path: string, body?: unknown, cookie?: string, ip = "10.0.0.1") =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const tokenFromOutbox = () => {
  const last = getOutbox().at(-1);
  return decodeURIComponent(/token=([^\s]+)/.exec(last?.text ?? "")?.[1] ?? "");
};

async function signUp(email = "new@example.com", ip?: string) {
  const res = await signup(post("/api/auth/signup", { email, password: "correct horse battery" }, undefined, ip));
  return { res, cookie: cookieOf(res) };
}

test("signup creates user, workspace and owner membership, and emails a verification link", async () => {
  const { res } = await signUp();
  expect(res.status).toBe(201);
  const [user] = await db.select().from(users);
  expect(user.emailVerifiedAt).toBeNull();
  const [member] = await db.select().from(memberships).where(eq(memberships.userId, user.id));
  expect(member.role).toBe("owner");
  expect(await db.select().from(workspaces)).toHaveLength(1);
  const outbox = getOutbox();
  expect(outbox).toHaveLength(1);
  expect(outbox[0].to).toBe("new@example.com");
  expect(outbox[0].text).toContain("http://localhost/verify?token=");
});

test("ALLOW_SIGNUP=false still closes sign-up and sends nothing", async () => {
  process.env.ALLOW_SIGNUP = "false";
  const { res } = await signUp();
  expect(res.status).toBe(403);
  expect(getOutbox()).toHaveLength(0);
});

test("signup is rate limited per IP and per email", async () => {
  for (let i = 0; i < 5; i++) expect((await signUp(`u${i}@example.com`, "9.9.9.9")).res.status).toBe(201);
  expect((await signUp("u6@example.com", "9.9.9.9")).res.status).toBe(429);

  await getRateLimitStore().reset();
  for (let i = 0; i < 5; i++) await signUp("same@example.com", `1.1.1.${i}`);
  expect((await signUp("same@example.com", "1.1.1.9")).res.status).toBe(429);
});

test("the emailed token verifies the email once", async () => {
  await signUp();
  const token = tokenFromOutbox();
  expect(await verifyEmailToken(db, token)).toBe(true);
  const [user] = await db.select().from(users);
  expect(user.emailVerifiedAt).not.toBeNull();
  expect(await verifyEmailToken(db, token)).toBe(false);
});

test("unknown and expired tokens do not verify", async () => {
  await signUp();
  expect(await verifyEmailToken(db, "nope")).toBe(false);
  const token = tokenFromOutbox();
  await db.update(authTokens).set({ expiresAt: new Date(Date.now() - 1000) });
  expect(await verifyEmailToken(db, token)).toBe(false);
  expect((await db.select().from(users))[0].emailVerifiedAt).toBeNull();
});

test("resend needs a session, emails a fresh link and is rate limited", async () => {
  expect((await resend(post("/api/auth/verify/resend"))).status).toBe(401);
  const { cookie } = await signUp();
  expect((await resend(post("/api/auth/verify/resend", undefined, cookie))).status).toBe(200);
  expect(getOutbox()).toHaveLength(2);
  await resend(post("/api/auth/verify/resend", undefined, cookie));
  await resend(post("/api/auth/verify/resend", undefined, cookie));
  expect((await resend(post("/api/auth/verify/resend", undefined, cookie))).status).toBe(429);
});

test("resend for a verified user sends nothing", async () => {
  const { cookie } = await signUp();
  await verifyEmailToken(db, tokenFromOutbox());
  clearOutbox();
  const res = await resend(post("/api/auth/verify/resend", undefined, cookie));
  expect((await res.json()).alreadyVerified).toBe(true);
  expect(getOutbox()).toHaveLength(0);
});

test("an unverified user cannot start an interaction until the email is verified", async () => {
  const { cookie } = await signUp();
  const [user] = await db.select().from(users);
  const [member] = await db.select().from(memberships).where(eq(memberships.userId, user.id));
  const [event] = await db
    .insert(events)
    .values({ ownerId: user.id, workspaceId: member.workspaceId, name: "E", startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000), joinCode: "123456" })
    .returning();
  const [interaction] = await db
    .insert(interactions)
    .values({ eventId: event.id, type: "poll", title: "Q", position: 0, config: { options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } })
    .returning();
  const ctx = { params: Promise.resolve({ id: event.id, interactionId: interaction.id }) };

  const blocked = await start(post("/x", undefined, cookie), ctx);
  expect(blocked.status).toBe(403);
  expect((await blocked.json()).reason).toBe("email_unverified");

  await verifyEmailToken(db, tokenFromOutbox());
  expect((await start(post("/x", undefined, cookie), ctx)).status).toBe(200);
});
