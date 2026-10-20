// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recoveryCodes, userTotp, users } from "@/db/schema";
import { createPendingTwoFactorToken } from "@/lib/auth/pending-two-factor";
import { totp as totpAt } from "@/lib/auth/totp";
import { TWOFA_ATTEMPT_LIMIT } from "@/lib/auth/two-factor";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request) => Promise<Response>;
let login: Handler;
let signup: Handler;
let me: Handler;
let status: Handler;
let enrol: Handler;
let confirm: Handler;
let disable: Handler;
let verify: Handler;
let reset: Handler;
let getRateLimitStore: typeof import("@/lib/rate-limit").getRateLimitStore;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  login = (await import("@/app/api/auth/login/route")).POST;
  signup = (await import("@/app/api/auth/signup/route")).POST;
  me = (await import("@/app/api/auth/me/route")).GET;
  status = (await import("@/app/api/auth/2fa/route")).GET;
  enrol = (await import("@/app/api/auth/2fa/enrol/route")).POST;
  confirm = (await import("@/app/api/auth/2fa/confirm/route")).POST;
  disable = (await import("@/app/api/auth/2fa/disable/route")).POST;
  verify = (await import("@/app/api/auth/2fa/verify/route")).POST;
  reset = (await import("@/app/api/auth/reset/route")).POST;
  getRateLimitStore = (await import("@/lib/rate-limit")).getRateLimitStore;
});

beforeEach(async () => {
  vi.stubEnv("TWOFA_ENCRYPTION_KEY", "b".repeat(64));
  await truncateAll(db);
  await getRateLimitStore().reset();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => pool.end());

const creds = { email: "host@example.com", password: "correct horse battery" };

function post(path: string, body: unknown, cookie?: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}
const get = (path: string, cookie?: string) => new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const totp = (secret: string) => totpAt(secret, Date.now());
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signedUp() {
  const res = await signup(post("/api/auth/signup", creds));
  return cookieOf(res);
}

/** Signs up and turns 2FA on; returns the session cookie, the secret and the recovery codes. */
async function enrolled() {
  const cookie = await signedUp();
  const { secret } = await (await enrol(post("/api/auth/2fa/enrol", {}, cookie))).json();
  const res = await confirm(post("/api/auth/2fa/confirm", { code: totp(secret) }, cookie));
  const { recoveryCodes: codes } = await res.json();
  return { cookie, secret, codes: codes as string[] };
}

async function loginPending() {
  const res = await login(post("/api/auth/login", creds));
  return { res, body: await res.json() };
}

describe("enrolment", () => {
  it("needs a session", async () => {
    expect((await enrol(post("/api/auth/2fa/enrol", {}))).status).toBe(401);
    expect((await confirm(post("/api/auth/2fa/confirm", { code: "123456" }))).status).toBe(401);
    expect((await disable(post("/api/auth/2fa/disable", {}))).status).toBe(401);
    expect((await status(get("/api/auth/2fa"))).status).toBe(401);
  });

  it("returns the otpauth URI and secret, then the recovery codes once a first code is confirmed", async () => {
    const cookie = await signedUp();
    const started = await enrol(post("/api/auth/2fa/enrol", {}, cookie));
    expect(started.status).toBe(200);
    const { secret, uri } = await started.json();
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain(secret);
    expect(await (await status(get("/api/auth/2fa", cookie))).json()).toMatchObject({ enabled: false, pending: true });

    const wrong = await confirm(post("/api/auth/2fa/confirm", { code: "000000" }, cookie));
    expect(wrong.status).toBe(400);

    const ok = await confirm(post("/api/auth/2fa/confirm", { code: totp(secret) }, cookie));
    expect(ok.status).toBe(200);
    expect((await ok.json()).recoveryCodes).toHaveLength(10);
    expect(await (await status(get("/api/auth/2fa", cookie))).json()).toMatchObject({
      enabled: true,
      recoveryCodesLeft: 10,
    });
    // Once on, starting again is refused and the secret stays.
    expect((await enrol(post("/api/auth/2fa/enrol", {}, cookie))).status).toBe(409);
  });

  it("confirm without a started enrolment is a 409", async () => {
    const cookie = await signedUp();
    expect((await confirm(post("/api/auth/2fa/confirm", { code: "123456" }, cookie))).status).toBe(409);
  });

  it("answers 503 when the encryption key is missing", async () => {
    const cookie = await signedUp();
    vi.stubEnv("TWOFA_ENCRYPTION_KEY", "");
    expect((await enrol(post("/api/auth/2fa/enrol", {}, cookie))).status).toBe(503);
  });

  it("does not end existing sessions", async () => {
    const first = await signedUp();
    const other = cookieOf(await login(post("/api/auth/login", creds)));
    const { secret } = await (await enrol(post("/api/auth/2fa/enrol", {}, first))).json();
    await confirm(post("/api/auth/2fa/confirm", { code: totp(secret) }, first));
    const cookie = first;
    expect((await me(get("/api/auth/me", other))).status).toBe(200);
    expect((await me(get("/api/auth/me", cookie))).status).toBe(200);
    const [row] = await db.select({ after: users.sessionsValidAfter }).from(users);
    expect(row.after).toBeNull();
  });
});

describe("login", () => {
  it("without 2FA still sets the session cookie", async () => {
    await signedUp();
    const res = await login(post("/api/auth/login", creds));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^session=/);
  });

  it("with 2FA returns a pending token and no cookie", async () => {
    await enrolled();
    const { res, body } = await loginPending();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(body.twoFactorRequired).toBe(true);
    expect(typeof body.pendingToken).toBe("string");
    // The pending token is not a session.
    expect((await me(get("/api/auth/me", `session=${body.pendingToken}`))).status).toBe(401);
  });

  it("a wrong password gives the usual 401 with no pending token", async () => {
    await enrolled();
    const res = await login(post("/api/auth/login", { ...creds, password: "wrong password here" }));
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("pendingToken");
  });

  it("accepts an authenticator code and sets the session cookie", async () => {
    const { secret } = await enrolled();
    const { body } = await loginPending();
    const res = await verify(post("/api/auth/2fa/verify", { pendingToken: body.pendingToken, code: totp(secret) }));
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^session=/);
    expect((await me(get("/api/auth/me", cookie))).status).toBe(200);
    const [row] = await db.select({ last: users.lastLoginAt }).from(users);
    expect(row.last).not.toBeNull();
  });

  it("accepts a recovery code once and ends the other sessions", async () => {
    const { cookie: oldCookie, codes } = await enrolled();
    expect((await me(get("/api/auth/me", oldCookie))).status).toBe(200);
    await wait(5);

    const first = await loginPending();
    const res = await verify(post("/api/auth/2fa/verify", { pendingToken: first.body.pendingToken, code: codes[0] }));
    expect(res.status).toBe(200);
    const fresh = cookieOf(res);
    expect((await me(get("/api/auth/me", fresh))).status).toBe(200);
    expect((await me(get("/api/auth/me", oldCookie))).status).toBe(401);

    const second = await loginPending();
    const again = await verify(post("/api/auth/2fa/verify", { pendingToken: second.body.pendingToken, code: codes[0] }));
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
    // Another unused code still works.
    const other = await verify(post("/api/auth/2fa/verify", { pendingToken: second.body.pendingToken, code: codes[1].toLowerCase() }));
    expect(other.status).toBe(200);
  });

  it("an authenticator code leaves other sessions alone", async () => {
    const { cookie: oldCookie, secret } = await enrolled();
    const { body } = await loginPending();
    await verify(post("/api/auth/2fa/verify", { pendingToken: body.pendingToken, code: totp(secret) }));
    expect((await me(get("/api/auth/me", oldCookie))).status).toBe(200);
  });

  it("gives the same answer for a bad code, a bad token and an expired token", async () => {
    const { secret } = await enrolled();
    const { body } = await loginPending();
    const [row] = await db.select({ id: users.id }).from(users);
    const expired = createPendingTwoFactorToken(row.id, Date.now() - 10 * 60_000);

    const answers = await Promise.all(
      [
        { pendingToken: body.pendingToken, code: "000000" },
        { pendingToken: "garbage", code: totp(secret) },
        { pendingToken: expired, code: totp(secret) },
        { code: totp(secret) },
      ].map(async (payload) => {
        const res = await verify(post("/api/auth/2fa/verify", payload));
        return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie") };
      }),
    );
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(answers[0].status).toBe(401);
    expect(answers[0].cookie).toBeNull();
  });

  it("a session token cannot stand in for a pending token", async () => {
    const { cookie, secret } = await enrolled();
    const res = await verify(post("/api/auth/2fa/verify", { pendingToken: cookie.replace("session=", ""), code: totp(secret) }));
    expect(res.status).toBe(401);
  });

  it("rate limits wrong codes and then refuses even a right one", async () => {
    const { secret } = await enrolled();
    const { body } = await loginPending();
    // Enrolment used one attempt from the shared budget.
    for (let i = 0; i < TWOFA_ATTEMPT_LIMIT - 1; i++) {
      const res = await verify(post("/api/auth/2fa/verify", { pendingToken: body.pendingToken, code: "000000" }));
      expect(res.status).toBe(401);
    }
    const blocked = await verify(post("/api/auth/2fa/verify", { pendingToken: body.pendingToken, code: totp(secret) }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("set-cookie")).toBeNull();
  });

  it("a password reset does not log in a user who has 2FA", async () => {
    await enrolled();
    const { issueToken } = await import("@/lib/auth/tokens");
    const [row] = await db.select({ id: users.id }).from(users);
    const token = await issueToken(db, { userId: row.id, purpose: "reset_password", ttlMs: 60_000 });
    const res = await reset(post("/api/auth/reset", { token, password: "a brand new password" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await res.json()).loginRequired).toBe(true);
  });
});

describe("disable", () => {
  it("needs the password and a valid code", async () => {
    const { cookie, secret } = await enrolled();
    const noCode = await disable(post("/api/auth/2fa/disable", { password: creds.password, code: "000000" }, cookie));
    const noPassword = await disable(post("/api/auth/2fa/disable", { password: "nope nope nope", code: totp(secret) }, cookie));
    expect(noCode.status).toBe(400);
    expect(noPassword.status).toBe(400);
    expect(await noCode.json()).toEqual(await noPassword.json());
    expect(await db.select().from(userTotp)).toHaveLength(1);
  });

  it("removes the secret and codes, ends other sessions and keeps this device signed in", async () => {
    const { cookie, secret } = await enrolled();
    const { cookie: other } = await (async () => {
      const { body } = await loginPending();
      const res = await verify(post("/api/auth/2fa/verify", { pendingToken: body.pendingToken, code: totp(secret) }));
      return { cookie: cookieOf(res) };
    })();
    await wait(5);

    const res = await disable(post("/api/auth/2fa/disable", { password: creds.password, code: totp(secret) }, cookie));
    expect(res.status).toBe(200);
    expect(await db.select().from(userTotp)).toHaveLength(0);
    expect(await db.select().from(recoveryCodes)).toHaveLength(0);
    const fresh = cookieOf(res);
    expect((await me(get("/api/auth/me", fresh))).status).toBe(200);
    expect((await me(get("/api/auth/me", cookie))).status).toBe(401);
    expect((await me(get("/api/auth/me", other))).status).toBe(401);

    // Login is back to password only.
    const again = await login(post("/api/auth/login", creds));
    expect(again.headers.get("set-cookie")).toMatch(/^session=/);
  });

  it("accepts a recovery code in place of the authenticator code", async () => {
    const { cookie, codes } = await enrolled();
    const res = await disable(post("/api/auth/2fa/disable", { password: creds.password, code: codes[2] }, cookie));
    expect(res.status).toBe(200);
    expect(await db.select().from(userTotp).where(eq(userTotp.userId, (await db.select().from(users))[0].id))).toHaveLength(0);
  });

  it("is a 409 when 2FA is not on", async () => {
    const cookie = await signedUp();
    const res = await disable(post("/api/auth/2fa/disable", { password: creds.password, code: "123456" }, cookie));
    expect(res.status).toBe(409);
  });

  it("rate limits repeated wrong attempts", async () => {
    const { cookie } = await enrolled();
    let last = 0;
    for (let i = 0; i < TWOFA_ATTEMPT_LIMIT + 1; i++) {
      last = (await disable(post("/api/auth/2fa/disable", { password: creds.password, code: "000000" }, cookie))).status;
    }
    expect(last).toBe(429);
  });
});
