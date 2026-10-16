// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { users } from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request) => Promise<Response>;
let signup: Handler;
let login: Handler;
let logout: Handler;
let me: Handler;
let requireAdmin: typeof import("@/lib/auth/require-admin").requireAdmin;
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  signup = (await import("@/app/api/auth/signup/route")).POST;
  login = (await import("@/app/api/auth/login/route")).POST;
  logout = (await import("@/app/api/auth/logout/route")).POST;
  me = (await import("@/app/api/auth/me/route")).GET;
  requireAdmin = (await import("@/lib/auth/require-admin")).requireAdmin;
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

beforeEach(async () => {
  await truncateAll(db);
  await getRateLimitStore().reset();
});
afterAll(() => pool.end());

function post(path: string, body: unknown, cookie?: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string) {
  return new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });
}

function sessionCookie(res: Response) {
  const header = res.headers.get("set-cookie") ?? "";
  return header.split(";")[0];
}

const creds = { email: "Host@Example.com", password: "correct horse battery" };

test("signup creates a lowercase-email user with a hashed password and logs in", async () => {
  const res = await signup(post("/api/auth/signup", creds));
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.user.email).toBe("host@example.com");
  expect(body.user).not.toHaveProperty("passwordHash");

  const [row] = await db.select().from(users);
  expect(row.passwordHash).not.toContain(creds.password);

  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/SameSite=Lax/i);
  expect(setCookie).not.toMatch(/Secure/i); // request was plain http

  const meRes = await me(get("/api/auth/me", sessionCookie(res)));
  expect(meRes.status).toBe(200);
  expect((await meRes.json()).user.email).toBe("host@example.com");
});

test("signup rejects invalid input with 400", async () => {
  expect((await signup(post("/api/auth/signup", { email: "nope", password: "longenough1" }))).status).toBe(400);
  expect((await signup(post("/api/auth/signup", { email: "a@b.co", password: "short" }))).status).toBe(400);
});

test("signup with a duplicate email returns 409 regardless of case", async () => {
  await signup(post("/api/auth/signup", creds));
  const res = await signup(post("/api/auth/signup", { ...creds, email: "host@example.com" }));
  expect(res.status).toBe(409);
});

test("login succeeds with correct credentials", async () => {
  await signup(post("/api/auth/signup", creds));
  const res = await login(post("/api/auth/login", creds));
  expect(res.status).toBe(200);
  const meRes = await me(get("/api/auth/me", sessionCookie(res)));
  expect(meRes.status).toBe(200);
});

test("login with a bad password or unknown email returns the same generic 401", async () => {
  await signup(post("/api/auth/signup", creds));
  const bad = await login(post("/api/auth/login", { ...creds, password: "wrong password!" }));
  const unknown = await login(post("/api/auth/login", { email: "who@example.com", password: "whatever123" }));
  expect(bad.status).toBe(401);
  expect(unknown.status).toBe(401);
  expect(await bad.json()).toEqual(await unknown.json());
  expect(bad.headers.get("set-cookie")).toBeNull();
});

test("inactive users cannot log in and lose their session", async () => {
  const signedUp = await signup(post("/api/auth/signup", creds));
  await db.update(users).set({ active: false }).where(eq(users.email, "host@example.com"));

  const res = await login(post("/api/auth/login", creds));
  expect(res.status).toBe(401);

  const meRes = await me(get("/api/auth/me", sessionCookie(signedUp)));
  expect(meRes.status).toBe(401);
});

test("logout clears the session cookie", async () => {
  const res = await logout(post("/api/auth/logout", {}));
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
});

test("me returns 401 without a session or with a tampered cookie", async () => {
  expect((await me(get("/api/auth/me"))).status).toBe(401);
  const signedUp = await signup(post("/api/auth/signup", creds));
  const tampered = sessionCookie(signedUp).slice(0, -2) + "xx";
  expect((await me(get("/api/auth/me", tampered))).status).toBe(401);
});

test("requireAdmin rejects without a session and returns the user with one", async () => {
  const denied = await requireAdmin(get("/api/anything"));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.response.status).toBe(401);

  const signedUp = await signup(post("/api/auth/signup", creds));
  const allowed = await requireAdmin(get("/api/anything", sessionCookie(signedUp)));
  expect(allowed.ok).toBe(true);
  if (allowed.ok) expect(allowed.user.email).toBe("host@example.com");
});

test("login returns 429 after 10 attempts from one IP, even for different emails", async () => {
  const attempt = (email: string, ip: string) =>
    login(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ email, password: "wrong password!" }),
      }),
    );
  for (let i = 0; i < 10; i++) expect((await attempt(`u${i}@example.com`, "1.1.1.1")).status).toBe(401);
  const blocked = await attempt("another@example.com", "1.1.1.1");
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await attempt("another@example.com", "2.2.2.2")).status).toBe(401);
}, 30_000);

test("login returns 429 after 10 attempts for one email across IPs", async () => {
  const attempt = (ip: string) =>
    login(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ email: "Victim@Example.com", password: "wrong password!" }),
      }),
    );
  for (let i = 0; i < 10; i++) expect((await attempt(`10.0.0.${i}`)).status).toBe(401);
  expect((await attempt("10.0.0.99")).status).toBe(429);
}, 30_000);

test("login records first_login_at once", async () => {
  await signup(post("/api/auth/signup", creds));
  const read = async () =>
    (await db.select({ at: users.firstLoginAt }).from(users).where(eq(users.email, "host@example.com")))[0].at;
  expect(await read()).toBeNull();
  await login(post("/api/auth/login", creds));
  const first = await read();
  expect(first).toBeInstanceOf(Date);
  await login(post("/api/auth/login", creds));
  expect(await read()).toEqual(first);
});

test("cookies are Secure only when the request arrived over https", async () => {
  const body = JSON.stringify(creds);
  const make = (headers: Record<string, string>) =>
    new Request("http://app.example.test/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  const proxied = await signup(make({ "x-forwarded-proto": "https" }));
  expect(proxied.headers.get("set-cookie")).toMatch(/Secure/i);

  await truncateAll(db);
  const plain = await signup(make({}));
  expect(plain.headers.get("set-cookie")).not.toMatch(/Secure/i);
  const loggedIn = await login(
    new Request("http://192.0.2.10:3000/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  expect(loggedIn.status).toBe(200);
  expect(loggedIn.headers.get("set-cookie")).not.toMatch(/Secure/i);
});
