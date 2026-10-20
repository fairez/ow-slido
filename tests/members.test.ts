// @vitest-environment node
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { events, memberships, users, workspaces } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { getSessionMember } from "@/lib/auth/require-admin";
import { clearOutbox, getOutbox } from "@/lib/email";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const PASSWORD = "correct horse battery";
const { db, pool } = createTestDb();

type Handler = (req: Request) => Promise<Response>;
type UserHandler = (req: Request, ctx: { params: Promise<{ userId: string }> }) => Promise<Response>;
let login: Handler;
let me: Handler;
let list: Handler;
let patch: UserHandler;
let remove: UserHandler;
let resetPassword: UserHandler;
let publisher: typeof import("@/lib/realtime/publisher");
let session: typeof import("@/lib/auth/session");
const passwordHash = hashPassword(PASSWORD);

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  login = (await import("@/app/api/auth/login/route")).POST;
  me = (await import("@/app/api/auth/me/route")).GET;
  list = (await import("@/app/api/members/route")).GET;
  patch = (await import("@/app/api/members/[userId]/route")).PATCH;
  remove = (await import("@/app/api/members/[userId]/route")).DELETE;
  resetPassword = (await import("@/app/api/members/[userId]/password/route")).POST;
  publisher = await import("@/lib/realtime/publisher");
  session = await import("@/lib/auth/session");
});

let revoked: string[] = [];
beforeEach(async () => {
  await truncateAll(db);
  clearOutbox();
  revoked = [];
  publisher.setMemberRevoker((userId, workspaceId) => revoked.push(`${workspaceId}:${userId}`));
});
afterAll(() => {
  publisher.setMemberRevoker(null);
  return pool.end();
});

const req = (method: string, path: string, body?: unknown, cookie?: string) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-real-ip": "10.0.0.1", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const withId = (userId: string) => ({ params: Promise.resolve({ userId }) });

type Person = { user: typeof users.$inferSelect; workspaceId: string; cookie: string };

/** A verified user with a personal workspace (owner) and a session cookie, inserted directly to stay under the sign-up rate limit. */
async function makeUser(email: string): Promise<Person> {
  const [user] = await db.insert(users).values({ email, passwordHash: await passwordHash }).returning();
  const workspace = await createPersonalWorkspace(db, user);
  return { user, workspaceId: workspace.id, cookie: `session=${session.createSessionToken(user.id)}` };
}

/** The member emails the request sees: tells which workspace it acted in. */
async function seenBy(p: Person) {
  const res = await list(req("GET", "/api/members", undefined, p.cookie));
  return res.status === 200 ? (await res.json()).members.map((m: { email: string }) => m.email) : res.status;
}

/** An owner's workspace plus a member of each role; `cookie` on each member targets that workspace. */
async function team() {
  const owner = await makeUser("owner@example.com");
  await setPlan(db, owner.workspaceId, "team");
  const people: Record<string, Person> = { owner };
  for (const role of ["admin", "editor", "moderator", "viewer"] as const) {
    const p = await makeUser(`${role}@example.com`);
    await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: p.user.id, role });
    people[role] = { ...p, cookie: `${p.cookie}; workspace=${owner.workspaceId}` };
  }
  return { ws: owner.workspaceId, ...(people as Record<"owner" | "admin" | "editor" | "moderator" | "viewer", Person>) };
}

const change = (as: Person, target: Person, body: unknown) =>
  patch(req("PATCH", "/x", body, as.cookie), withId(target.user.id));
const drop = (as: Person, target: Person) => remove(req("DELETE", "/x", undefined, as.cookie), withId(target.user.id));
const reset = (as: Person, target: Person) =>
  resetPassword(req("POST", "/x", undefined, as.cookie), withId(target.user.id));
const roleOf = async (ws: string, p: Person) =>
  (await db.select().from(memberships).where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, p.user.id))))[0];
const canList = async (p: Person) => (await list(req("GET", "/api/members", undefined, p.cookie))).status;

test("owner and admin list the members; other roles cannot", async () => {
  const t = await team();
  const res = await list(req("GET", "/api/members", undefined, t.owner.cookie));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.selfId).toBe(t.owner.user.id);
  expect(body.members.map((m: { email: string }) => m.email).sort()).toEqual([
    "admin@example.com",
    "editor@example.com",
    "moderator@example.com",
    "owner@example.com",
    "viewer@example.com",
  ]);
  expect(JSON.stringify(body)).not.toContain("passwordHash");
  expect(await canList(t.admin)).toBe(200);
  for (const role of ["editor", "moderator", "viewer"] as const) expect(await canList(t[role])).toBe(403);
  expect(await list(req("GET", "/api/members"))).toHaveProperty("status", 401);
});

test("an owner changes roles; the change takes effect on the next request and drops live sockets", async () => {
  const t = await team();
  expect(await canList(t.editor)).toBe(403);
  expect((await change(t.owner, t.editor, { role: "admin" })).status).toBe(200);
  expect((await roleOf(t.ws, t.editor)).role).toBe("admin");
  expect(await canList(t.editor)).toBe(200);
  expect(revoked).toContain(`${t.ws}:${t.editor.user.id}`);

  expect((await change(t.owner, t.editor, { role: "viewer" })).status).toBe(200);
  expect(await canList(t.editor)).toBe(403);
  expect((await change(t.owner, t.editor, { role: "viewer" })).status).toBe(400);
});

test("bad bodies and ids are rejected", async () => {
  const t = await team();
  expect((await change(t.owner, t.editor, { role: "boss" })).status).toBe(400);
  expect((await change(t.owner, t.editor, { status: "gone" })).status).toBe(400);
  expect((await change(t.owner, t.editor, { role: "viewer", status: "suspended" })).status).toBe(400);
  expect((await change(t.owner, t.editor, {})).status).toBe(400);
  expect((await patch(req("PATCH", "/x", { role: "viewer" }, t.owner.cookie), withId("nope"))).status).toBe(404);
  const ghost = { user: { id: "00000000-0000-4000-8000-000000000000" } } as Person;
  expect((await change(t.owner, ghost, { role: "viewer" })).status).toBe(404);
  expect((await drop(t.owner, ghost)).status).toBe(404);
  expect((await reset(t.owner, ghost)).status).toBe(404);
});

test("admins cannot touch owners or grant the owner role; only an owner can", async () => {
  const t = await team();
  const second = await makeUser("second@example.com");
  await db.insert(memberships).values({ workspaceId: t.ws, userId: second.user.id, role: "owner" });
  const secondOwner = { ...second, cookie: `${second.cookie}; workspace=${t.ws}` };

  for (const res of [
    await change(t.admin, t.owner, { role: "viewer" }),
    await change(t.admin, t.owner, { status: "suspended" }),
    await drop(t.admin, t.owner),
    await reset(t.admin, t.owner),
    await change(t.admin, t.editor, { role: "owner" }),
    await change(t.admin, t.admin, { role: "owner" }),
  ]) {
    expect(res.status).toBe(403);
  }
  expect((await roleOf(t.ws, t.owner)).role).toBe("owner");
  expect((await roleOf(t.ws, t.editor)).role).toBe("editor");

  // Owners can grant the role and take it away again from another owner.
  expect((await change(t.owner, t.editor, { role: "owner" })).status).toBe(200);
  expect((await roleOf(t.ws, t.editor)).role).toBe("owner");
  expect((await change(secondOwner, t.editor, { role: "admin" })).status).toBe(200);
  expect((await change(t.owner, t.admin, { role: "editor" })).status).toBe(200);
});

test("admins manage non-owners, including other admins", async () => {
  const t = await team();
  expect((await change(t.admin, t.editor, { role: "moderator" })).status).toBe(200);
  expect((await change(t.admin, t.moderator, { status: "suspended" })).status).toBe(200);
  expect((await drop(t.admin, t.viewer)).status).toBe(200);
  const other = await makeUser("admin2@example.com");
  await db.insert(memberships).values({ workspaceId: t.ws, userId: other.user.id, role: "admin" });
  expect((await change(t.admin, other, { role: "viewer" })).status).toBe(200);
});

test("the last active owner cannot be removed, demoted or suspended", async () => {
  const t = await team();
  for (const res of [
    await change(t.owner, t.owner, { role: "admin" }),
    await change(t.admin, t.owner, { role: "admin" }),
    await drop(t.owner, t.owner),
    await change(t.owner, t.owner, { status: "suspended" }),
  ]) {
    expect([400, 403, 409]).toContain(res.status);
  }
  const demote = await change(t.owner, t.owner, { role: "admin" });
  expect(demote.status).toBe(409);
  expect((await demote.json()).reason).toBe("last_owner");
  const removal = await drop(t.owner, t.owner);
  expect(removal.status).toBe(409);
  expect((await roleOf(t.ws, t.owner)).role).toBe("owner");
  expect((await roleOf(t.ws, t.owner)).status).toBe("active");

  // A suspended owner does not count as active, so the remaining owner is still the last one.
  const second = await makeUser("second@example.com");
  await db.insert(memberships).values({ workspaceId: t.ws, userId: second.user.id, role: "owner", status: "suspended" });
  expect((await drop(t.owner, t.owner)).status).toBe(409);
  expect((await change(t.owner, t.owner, { role: "editor" })).status).toBe(409);

  // With a second active owner the first can step down, then the second is the last.
  await db.update(memberships).set({ status: "active" }).where(eq(memberships.userId, second.user.id));
  const secondOwner = { ...second, cookie: `${second.cookie}; workspace=${t.ws}` };
  expect((await change(t.owner, t.owner, { role: "editor" })).status).toBe(200);
  expect((await drop(secondOwner, secondOwner)).status).toBe(409);
  expect((await change(secondOwner, secondOwner, { status: "suspended" })).status).toBe(400);
});

test("the last-owner rule holds when two owners step down at once", async () => {
  const t = await team();
  const second = await makeUser("second@example.com");
  await db.insert(memberships).values({ workspaceId: t.ws, userId: second.user.id, role: "owner" });
  const secondOwner = { ...second, cookie: `${second.cookie}; workspace=${t.ws}` };
  const results = await Promise.all([
    change(t.owner, t.owner, { role: "admin" }),
    change(secondOwner, secondOwner, { role: "admin" }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  const owners = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, t.ws), eq(memberships.role, "owner")));
  expect(owners).toHaveLength(1);
});

test("a member cannot suspend themselves", async () => {
  const t = await team();
  for (const p of [t.admin, t.owner]) {
    expect((await change(p, p, { status: "suspended" })).status).toBe(400);
  }
  expect((await roleOf(t.ws, t.admin)).status).toBe("active");
});

test("suspending ends access to that workspace only; reactivating restores it", async () => {
  const t = await team();
  expect(await seenBy(t.admin)).toContain("owner@example.com");
  expect((await change(t.owner, t.admin, { status: "suspended" })).status).toBe(200);
  expect(revoked).toContain(`${t.ws}:${t.admin.user.id}`);

  // The workspace cookie still names it, but the suspended membership no longer counts: the request
  // falls back to their own workspace, and asking for the suspended one outright is refused.
  expect(await seenBy(t.admin)).toEqual(["admin@example.com"]);
  expect((await me(req("GET", "/api/auth/me", undefined, t.admin.cookie))).status).toBe(200);
  const suspended = await getSessionMember(req("GET", "/x", undefined, t.admin.cookie), t.ws);
  expect(suspended).toBeNull();

  expect((await change(t.owner, t.admin, { status: "suspended" })).status).toBe(400);
  expect((await change(t.owner, t.admin, { status: "active" })).status).toBe(200);
  expect(await seenBy(t.admin)).toContain("owner@example.com");
  expect(await getSessionMember(req("GET", "/x", undefined, t.admin.cookie), t.ws)).not.toBeNull();
  expect((await change(t.owner, t.admin, { status: "active" })).status).toBe(400);
});

test("removing a member deletes the membership but keeps their events, and the account", async () => {
  const t = await team();
  const when = { startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) };
  const [event] = await db
    .insert(events)
    .values({ workspaceId: t.ws, ownerId: t.editor.user.id, name: "Kept", joinCode: "424242", ...when })
    .returning();

  const res = await drop(t.owner, t.editor);
  expect(res.status).toBe(200);
  expect(revoked).toContain(`${t.ws}:${t.editor.user.id}`);
  expect(await db.select().from(memberships).where(and(eq(memberships.workspaceId, t.ws), eq(memberships.userId, t.editor.user.id)))).toHaveLength(0);
  expect((await db.select().from(events).where(eq(events.id, event.id)))[0]).toMatchObject({ workspaceId: t.ws, name: "Kept" });
  expect(await db.select().from(users).where(eq(users.id, t.editor.user.id))).toHaveLength(1);
  expect((await db.select().from(workspaces).where(eq(workspaces.id, t.ws))).length).toBe(1);

  // Their old workspace cookie no longer gets them in; they fall back to their own workspace.
  expect(await seenBy(t.editor)).toEqual(["editor@example.com"]);
  expect(await getSessionMember(req("GET", "/x", undefined, t.editor.cookie), t.ws)).toBeNull();
  expect((await drop(t.owner, t.editor)).status).toBe(404);
});

test("members of another workspace cannot be reached", async () => {
  const t = await team();
  const stranger = await makeUser("stranger@example.com");
  expect((await change(stranger, t.editor, { role: "viewer" })).status).toBe(404);
  expect((await drop(stranger, t.editor)).status).toBe(404);
  expect((await reset(stranger, t.editor)).status).toBe(404);
  expect((await roleOf(t.ws, t.editor)).role).toBe("editor");
});

test("a password reset returns a temporary password once, forces a change and ends the member's sessions", async () => {
  const t = await team();
  const oldCookie = t.editor.cookie;
  expect((await me(req("GET", "/api/auth/me", undefined, oldCookie))).status).toBe(200);

  const res = await reset(t.admin, t.editor);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const { temporaryPassword } = await res.json();
  expect(temporaryPassword.length).toBeGreaterThanOrEqual(12);

  const [row] = await db.select().from(users).where(eq(users.id, t.editor.user.id));
  expect(row.mustChangePassword).toBe(true);
  expect(row.sessionsValidAfter).not.toBeNull();
  expect(JSON.stringify(row)).not.toContain(temporaryPassword);
  expect(getOutbox()).toHaveLength(0);

  // The earlier session is dead; the temporary password works and then only reaches the change page.
  expect((await me(req("GET", "/api/auth/me", undefined, oldCookie))).status).toBe(401);
  expect((await login(req("POST", "/api/auth/login", { email: "editor@example.com", password: PASSWORD }))).status).toBe(401);
  const signedIn = await login(req("POST", "/api/auth/login", { email: "editor@example.com", password: temporaryPassword }));
  expect(signedIn.status).toBe(200);
  const fresh = cookieOf(signedIn);
  const blocked = await list(req("GET", "/api/members", undefined, fresh));
  expect(blocked.status).toBe(403);
  expect((await blocked.json()).reason).toBe("password_change_required");

  // A second reset gives a different password.
  const again = await (await reset(t.owner, t.editor)).json();
  expect(again.temporaryPassword).not.toBe(temporaryPassword);
});

test("a password reset needs members.manage, and nobody resets their own", async () => {
  const t = await team();
  expect((await reset(t.editor, t.viewer)).status).toBe(403);
  expect((await reset(t.viewer, t.viewer)).status).toBe(403);
  expect((await reset(t.owner, t.owner)).status).toBe(400);
  expect((await reset(t.admin, t.admin)).status).toBe(400);
  const [row] = await db.select().from(users).where(eq(users.id, t.viewer.user.id));
  expect(row.mustChangePassword).toBe(false);
});

test("only members.manage roles can change, suspend or remove members", async () => {
  const t = await team();
  for (const p of [t.editor, t.moderator, t.viewer]) {
    expect((await change(p, t.viewer, { role: "admin" })).status).toBe(403);
    expect((await change(p, t.viewer, { status: "suspended" })).status).toBe(403);
    expect((await drop(p, t.viewer)).status).toBe(403);
  }
  expect((await patch(req("PATCH", "/x", { role: "viewer" }), withId(t.viewer.user.id))).status).toBe(401);
  expect((await roleOf(t.ws, t.viewer)).role).toBe("viewer");
});
