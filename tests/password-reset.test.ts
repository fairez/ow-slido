// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { authTokens, users } from "@/db/schema";
import { clearOutbox, getOutbox } from "@/lib/email";
import { hashPassword } from "@/lib/auth/password";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request) => Promise<Response>;
let signup: Handler;
let login: Handler;
let logout: Handler;
let me: Handler;
let forgot: Handler;
let reset: Handler;
let changePassword: Handler;
let listEvents: Handler;
let session: typeof import("@/lib/auth/session");
let issueToken: typeof import("@/lib/auth/tokens").issueToken;
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  signup = (await import("@/app/api/auth/signup/route")).POST;
  login = (await import("@/app/api/auth/login/route")).POST;
  logout = (await import("@/app/api/auth/logout/route")).POST;
  me = (await import("@/app/api/auth/me/route")).GET;
  forgot = (await import("@/app/api/auth/forgot/route")).POST;
  reset = (await import("@/app/api/auth/reset/route")).POST;
  changePassword = (await import("@/app/api/auth/password/route")).POST;
  listEvents = (await import("@/app/api/events/route")).GET;
  session = await import("@/lib/auth/session");
  issueToken = (await import("@/lib/auth/tokens")).issueToken;
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
  clearOutbox();
});
afterAll(() => pool.end());

const OLD = "correct horse battery";
const NEW = "staple battery horse";

const req = (method: string, path: string, body?: unknown, cookie?: string, ip = "10.0.0.1") =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-real-ip": ip, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const post = (path: string, body: unknown, cookie?: string, ip?: string) => req("POST", path, body, cookie, ip);
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const tokenFromOutbox = () =>
  decodeURIComponent(/token=([^\s]+)/.exec(getOutbox().at(-1)?.text ?? "")?.[1] ?? "");

async function makeUser(email = "host@example.com") {
  const res = await signup(post("/api/auth/signup", { email, password: OLD }));
  expect(res.status).toBe(201);
  clearOutbox();
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user;
}

const logIn = async (email: string, password: string) => {
  const res = await login(post("/api/auth/login", { email, password }));
  return { res, cookie: cookieOf(res) };
};

test("forgot answers the same for known and unknown emails, and mails only the known one", async () => {
  await makeUser();
  const known = await forgot(post("/api/auth/forgot", { email: "host@example.com" }));
  const knownBody = await known.json();
  expect(getOutbox()).toHaveLength(1);
  expect(getOutbox()[0].to).toBe("host@example.com");
  expect(getOutbox()[0].text).toContain("http://localhost/reset?token=");

  clearOutbox();
  const unknown = await forgot(post("/api/auth/forgot", { email: "nobody@example.com" }));
  expect(unknown.status).toBe(known.status);
  expect(await unknown.json()).toEqual(knownBody);
  expect(getOutbox()).toHaveLength(0);
});

test("forgot sends nothing to a deactivated account", async () => {
  const user = await makeUser();
  await db.update(users).set({ active: false }).where(eq(users.id, user.id));
  const res = await forgot(post("/api/auth/forgot", { email: "host@example.com" }));
  expect(res.status).toBe(200);
  expect(getOutbox()).toHaveLength(0);
});

test("forgot is rate limited per email", async () => {
  await makeUser();
  for (let i = 0; i < 3; i++) {
    expect((await forgot(post("/api/auth/forgot", { email: "host@example.com" }, undefined, `2.2.2.${i}`))).status).toBe(200);
  }
  expect((await forgot(post("/api/auth/forgot", { email: "host@example.com" }, undefined, "2.2.2.9"))).status).toBe(429);
});

test("reset link sets a new password, signs the device in and the old password stops working", async () => {
  await makeUser();
  await forgot(post("/api/auth/forgot", { email: "host@example.com" }));
  const res = await reset(post("/api/auth/reset", { token: tokenFromOutbox(), password: NEW }));
  expect(res.status).toBe(200);
  const cookie = cookieOf(res);
  expect((await me(req("GET", "/api/auth/me", undefined, cookie))).status).toBe(200);

  expect((await logIn("host@example.com", OLD)).res.status).toBe(401);
  expect((await logIn("host@example.com", NEW)).res.status).toBe(200);
});

test("a reset link works once", async () => {
  await makeUser();
  await forgot(post("/api/auth/forgot", { email: "host@example.com" }));
  const token = tokenFromOutbox();
  expect((await reset(post("/api/auth/reset", { token, password: NEW }))).status).toBe(200);
  expect((await reset(post("/api/auth/reset", { token, password: "another password 1" }))).status).toBe(400);
  expect((await logIn("host@example.com", NEW)).res.status).toBe(200);
});

test("an expired reset link is rejected", async () => {
  const user = await makeUser();
  const token = await issueToken(db, { userId: user.id, purpose: "reset_password", ttlMs: -1000 });
  expect((await reset(post("/api/auth/reset", { token, password: NEW }))).status).toBe(400);
});

test("reset links expire after 60 minutes", async () => {
  await makeUser();
  await forgot(post("/api/auth/forgot", { email: "host@example.com" }));
  const [row] = await db.select().from(authTokens).where(eq(authTokens.purpose, "reset_password"));
  const minutes = (row.expiresAt.getTime() - Date.now()) / 60000;
  expect(minutes).toBeGreaterThan(59);
  expect(minutes).toBeLessThanOrEqual(60);
});

test("a verification token cannot reset a password", async () => {
  const user = await makeUser();
  const token = await issueToken(db, { userId: user.id, purpose: "verify_email", ttlMs: 60000 });
  expect((await reset(post("/api/auth/reset", { token, password: NEW }))).status).toBe(400);
});

test("a too-short new password is refused and keeps the link usable", async () => {
  await makeUser();
  await forgot(post("/api/auth/forgot", { email: "host@example.com" }));
  const token = tokenFromOutbox();
  expect((await reset(post("/api/auth/reset", { token, password: "short" }))).status).toBe(400);
  expect((await reset(post("/api/auth/reset", { token, password: NEW }))).status).toBe(200);
});

test("resetting ends every session issued before it", async () => {
  await makeUser();
  const a = await logIn("host@example.com", OLD);
  const b = await logIn("host@example.com", OLD);
  expect((await me(req("GET", "/api/auth/me", undefined, a.cookie))).status).toBe(200);

  await forgot(post("/api/auth/forgot", { email: "host@example.com" }));
  await reset(post("/api/auth/reset", { token: tokenFromOutbox(), password: NEW }));

  expect((await me(req("GET", "/api/auth/me", undefined, a.cookie))).status).toBe(401);
  expect((await me(req("GET", "/api/auth/me", undefined, b.cookie))).status).toBe(401);
});

test("changing the password ends other sessions and keeps this device signed in", async () => {
  await makeUser();
  const here = await logIn("host@example.com", OLD);
  const other = await logIn("host@example.com", OLD);

  const res = await changePassword(
    post("/api/auth/password", { currentPassword: OLD, newPassword: NEW }, here.cookie),
  );
  expect(res.status).toBe(200);
  const fresh = cookieOf(res);
  expect(fresh).toMatch(/^session=/);

  expect((await me(req("GET", "/api/auth/me", undefined, fresh))).status).toBe(200);
  expect((await me(req("GET", "/api/auth/me", undefined, other.cookie))).status).toBe(401);
  expect((await me(req("GET", "/api/auth/me", undefined, here.cookie))).status).toBe(401);
  expect((await logIn("host@example.com", NEW)).res.status).toBe(200);
});

test("a session cookie minted a second before the change is rejected", async () => {
  const user = await makeUser();
  const old = `${session.SESSION_COOKIE}=${session.createSessionToken(user.id, Date.now() - 1000)}`;
  expect((await me(req("GET", "/api/auth/me", undefined, old))).status).toBe(200);
  await db.update(users).set({ sessionsValidAfter: new Date() }).where(eq(users.id, user.id));
  expect((await me(req("GET", "/api/auth/me", undefined, old))).status).toBe(401);
});

test("change password needs the right current password and a long enough new one", async () => {
  await makeUser();
  const { cookie } = await logIn("host@example.com", OLD);
  expect((await changePassword(post("/api/auth/password", { currentPassword: "wrong wrong", newPassword: NEW }, cookie))).status).toBe(400);
  expect((await changePassword(post("/api/auth/password", { currentPassword: OLD, newPassword: "short" }, cookie))).status).toBe(400);
  expect((await changePassword(post("/api/auth/password", { currentPassword: OLD, newPassword: NEW }))).status).toBe(401);
  expect((await logIn("host@example.com", OLD)).res.status).toBe(200);
});

test("forced change: APIs answer 403 until the password is changed", async () => {
  const user = await makeUser();
  const { cookie } = await logIn("host@example.com", OLD);
  await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, user.id));

  const blocked = await listEvents(req("GET", "/api/events", undefined, cookie));
  expect(blocked.status).toBe(403);
  expect((await blocked.json()).reason).toBe("password_change_required");

  // The change-password page, its API, /me and logout stay reachable.
  expect((await me(req("GET", "/api/auth/me", undefined, cookie))).status).toBe(200);
  expect((await logout(post("/api/auth/logout", {}, cookie))).status).toBe(200);
  const changed = await changePassword(post("/api/auth/password", { currentPassword: OLD, newPassword: NEW }, cookie));
  expect(changed.status).toBe(200);

  const [row] = await db.select().from(users).where(eq(users.id, user.id));
  expect(row.mustChangePassword).toBe(false);
  expect((await listEvents(req("GET", "/api/events", undefined, cookieOf(changed)))).status).toBe(200);
});

test("a reset clears the forced-change flag", async () => {
  const user = await makeUser();
  await db.update(users).set({ mustChangePassword: true, passwordHash: await hashPassword("temp password 1") }).where(eq(users.id, user.id));
  await forgot(post("/api/auth/forgot", { email: "host@example.com" }));
  const res = await reset(post("/api/auth/reset", { token: tokenFromOutbox(), password: NEW }));
  expect((await listEvents(req("GET", "/api/events", undefined, cookieOf(res)))).status).toBe(200);
});
