// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { authTokens, invitations, memberships, users, workspaces } from "@/db/schema";
import { clearOutbox, getOutbox } from "@/lib/email";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request) => Promise<Response>;
type IdHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let signup: Handler;
let login: Handler;
let listInvites: Handler;
let createInvite: Handler;
let revokeInvite: IdHandler;
let acceptInvite: Handler;
let session: typeof import("@/lib/auth/session");

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  signup = (await import("@/app/api/auth/signup/route")).POST;
  login = (await import("@/app/api/auth/login/route")).POST;
  listInvites = (await import("@/app/api/invitations/route")).GET;
  createInvite = (await import("@/app/api/invitations/route")).POST;
  revokeInvite = (await import("@/app/api/invitations/[id]/route")).DELETE;
  acceptInvite = (await import("@/app/api/invitations/accept/route")).POST;
  session = await import("@/lib/auth/session");
});

beforeEach(async () => {
  await truncateAll(db);
  clearOutbox();
});
afterAll(() => pool.end());

const PASSWORD = "correct horse battery";

const req = (method: string, path: string, body?: unknown, cookie?: string) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", "x-real-ip": "10.0.0.1", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const withId = (id: string) => ({ params: Promise.resolve({ id }) });

/** Signs up through the route (personal workspace, owner), verifies the email and returns the session cookie. */
async function makeOwner(email = "owner@example.com") {
  const res = await signup(req("POST", "/api/auth/signup", { email, password: PASSWORD }));
  expect(res.status).toBe(201);
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, email));
  const [user] = await db.select().from(users).where(eq(users.email, email));
  const [membership] = await db.select().from(memberships).where(eq(memberships.userId, user.id));
  await setPlan(db, membership.workspaceId, "team");
  return { user, workspaceId: membership.workspaceId, cookie: cookieOf(res) };
}

const invite = (cookie: string, email: string, role: string = "editor") =>
  createInvite(req("POST", "/api/invitations", { email, role }, cookie));
const tokenOf = (link: string) => new URL(link).searchParams.get("token") ?? "";

async function invited(email = "new@example.com", role = "editor") {
  const owner = await makeOwner();
  const res = await invite(owner.cookie, email, role);
  expect(res.status).toBe(201);
  const body = await res.json();
  return { owner, body, token: tokenOf(body.link) };
}

test("create returns the link once, emails it and lists the invitation without a token", async () => {
  const owner = await makeOwner();
  const res = await invite(owner.cookie, "New@Example.com", "viewer");
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.invitation).toMatchObject({ email: "new@example.com", role: "viewer", status: "pending" });
  expect(body.link).toContain("http://localhost/invite?token=");
  expect(body.emailSent).toBe(true);
  expect(getOutbox().at(-1)?.to).toBe("new@example.com");
  expect(getOutbox().at(-1)?.text).toContain(body.link);

  const [row] = await db.select().from(invitations);
  const [token] = await db.select().from(authTokens).where(eq(authTokens.id, row.tokenId));
  expect(token.purpose).toBe("invite");
  expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
  expect(row.invitedBy).toBe(owner.user.id);

  const list = await (await listInvites(req("GET", "/api/invitations", undefined, owner.cookie))).json();
  expect(list.invitations).toHaveLength(1);
  expect(JSON.stringify(list)).not.toContain(tokenOf(body.link));
});

test("owner role, bad roles, bad emails and duplicate pending invites are rejected", async () => {
  const owner = await makeOwner();
  expect((await invite(owner.cookie, "a@example.com", "owner")).status).toBe(400);
  expect((await invite(owner.cookie, "a@example.com", "boss")).status).toBe(400);
  expect((await invite(owner.cookie, "not-an-email")).status).toBe(400);
  expect((await invite(owner.cookie, "a@example.com")).status).toBe(201);
  const dup = await invite(owner.cookie, "A@example.com", "viewer");
  expect(dup.status).toBe(409);
  const same = await invite(owner.cookie, owner.user.email);
  expect(same.status).toBe(409);
});

test("only members.manage roles can invite, list or revoke; unverified owners cannot invite", async () => {
  const { owner, body } = await invited();
  const editor = await makeOwner("editor@example.com");
  await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: editor.user.id, role: "editor" });
  const asEditor = `${editor.cookie}; workspace=${owner.workspaceId}`;
  expect((await invite(asEditor, "x@example.com")).status).toBe(403);
  expect((await listInvites(req("GET", "/api/invitations", undefined, asEditor))).status).toBe(403);
  expect((await revokeInvite(req("DELETE", "/x", undefined, asEditor), withId(body.invitation.id))).status).toBe(403);
  expect((await invite("", "x@example.com")).status).toBe(401);

  await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, owner.user.id));
  const res = await invite(owner.cookie, "y@example.com");
  expect(res.status).toBe(403);
  expect((await res.json()).reason).toBe("email_unverified");
});

test("an admin can invite, and a workspace cannot see another workspace's invitations", async () => {
  const { owner, body } = await invited();
  const admin = await makeOwner("admin@example.com");
  await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: admin.user.id, role: "admin" });
  const asAdmin = `${admin.cookie}; workspace=${owner.workspaceId}`;
  expect((await invite(asAdmin, "x@example.com", "moderator")).status).toBe(201);

  // The admin's own personal workspace has no invitations and cannot revoke across workspaces.
  const own = admin.cookie;
  const list = await (await listInvites(req("GET", "/api/invitations", undefined, own))).json();
  expect(list.invitations).toHaveLength(0);
  const res = await revokeInvite(req("DELETE", "/x", undefined, own), withId(body.invitation.id));
  expect(res.status).toBe(404);
});

test("revoke makes the link unusable and frees the email for a new invite", async () => {
  const { owner, body, token } = await invited();
  const res = await revokeInvite(req("DELETE", "/x", undefined, owner.cookie), withId(body.invitation.id));
  expect(res.status).toBe(200);
  const [row] = await db.select().from(invitations);
  expect(row.status).toBe("revoked");

  const accept = await acceptInvite(req("POST", "/api/invitations/accept", { token, password: PASSWORD }));
  expect(accept.status).toBe(400);
  expect(await db.select().from(users).where(eq(users.email, "new@example.com"))).toHaveLength(0);

  expect((await revokeInvite(req("DELETE", "/x", undefined, owner.cookie), withId(body.invitation.id))).status).toBe(409);
  expect((await invite(owner.cookie, "new@example.com")).status).toBe(201);
  expect((await revokeInvite(req("DELETE", "/x", undefined, owner.cookie), withId("nope"))).status).toBe(404);
});

test("a new user sets a password, is created verified, joined with the role and signed in", async () => {
  const { owner, token } = await invited("new@example.com", "moderator");
  const res = await acceptInvite(req("POST", "/api/invitations/accept", { token, password: PASSWORD }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ workspaceId: owner.workspaceId, role: "moderator" });

  const [user] = await db.select().from(users).where(eq(users.email, "new@example.com"));
  expect(user.emailVerifiedAt).not.toBeNull();
  const [membership] = await db.select().from(memberships).where(eq(memberships.userId, user.id));
  expect(membership).toMatchObject({ workspaceId: owner.workspaceId, role: "moderator", status: "active" });
  const [row] = await db.select().from(invitations);
  expect(row.status).toBe("accepted");

  const cookies = res.headers.getSetCookie();
  expect(cookies.some((c) => c.startsWith(`${session.SESSION_COOKIE}=`))).toBe(true);
  expect(cookies.some((c) => c.includes(`workspace=${owner.workspaceId}`))).toBe(true);
  const signedIn = await login(req("POST", "/api/auth/login", { email: "new@example.com", password: PASSWORD }));
  expect(signedIn.status).toBe(200);
});

test("a new user needs a password of the minimum length, and a short one does not spend the link", async () => {
  const { token } = await invited();
  const none = await acceptInvite(req("POST", "/api/invitations/accept", { token }));
  expect(none.status).toBe(400);
  expect((await none.json()).reason).toBe("password_required");
  expect((await acceptInvite(req("POST", "/api/invitations/accept", { token, password: "short" }))).status).toBe(400);
  expect((await db.select().from(invitations))[0].status).toBe("pending");
  expect((await acceptInvite(req("POST", "/api/invitations/accept", { token, password: PASSWORD }))).status).toBe(200);
});

test("an existing user must log in; the matching account joins, a different one is refused", async () => {
  const { owner, token } = await invited("guest@example.com", "viewer");
  const guest = await makeOwner("guest@example.com");
  const stranger = await makeOwner("stranger@example.com");

  const anonymous = await acceptInvite(req("POST", "/api/invitations/accept", { token, password: PASSWORD }));
  expect(anonymous.status).toBe(401);
  expect((await anonymous.json()).reason).toBe("login_required");

  const wrong = await acceptInvite(req("POST", "/api/invitations/accept", { token }, stranger.cookie));
  expect(wrong.status).toBe(403);
  expect((await wrong.json()).reason).toBe("wrong_email");
  expect((await db.select().from(invitations))[0].status).toBe("pending");

  const ok = await acceptInvite(req("POST", "/api/invitations/accept", { token }, guest.cookie));
  expect(ok.status).toBe(200);
  const rows = await db.select().from(memberships).where(eq(memberships.userId, guest.user.id));
  expect(rows.map((r) => r.workspaceId).sort()).toEqual([guest.workspaceId, owner.workspaceId].sort());
  expect(rows.find((r) => r.workspaceId === owner.workspaceId)?.role).toBe("viewer");
});

test("accepting twice fails and creates nothing the second time", async () => {
  const { token } = await invited();
  expect((await acceptInvite(req("POST", "/api/invitations/accept", { token, password: PASSWORD }))).status).toBe(200);
  const again = await acceptInvite(req("POST", "/api/invitations/accept", { token, password: "another password" }));
  expect(again.status).toBe(400);
  expect(await db.select().from(users).where(eq(users.email, "new@example.com"))).toHaveLength(1);
});

test("an expired invitation cannot be accepted and its email can be invited again", async () => {
  const { owner, token } = await invited();
  const past = new Date(Date.now() - 1000);
  await db.update(invitations).set({ expiresAt: past });
  await db.update(authTokens).set({ expiresAt: past });

  const res = await acceptInvite(req("POST", "/api/invitations/accept", { token, password: PASSWORD }));
  expect(res.status).toBe(400);
  expect(await db.select().from(users).where(eq(users.email, "new@example.com"))).toHaveLength(0);

  const list = await (await listInvites(req("GET", "/api/invitations", undefined, owner.cookie))).json();
  expect(list.invitations[0].status).toBe("expired");
  expect((await invite(owner.cookie, "new@example.com")).status).toBe(201);
});

test("an unknown token is rejected", async () => {
  await makeOwner();
  expect((await acceptInvite(req("POST", "/api/invitations/accept", { token: "nope", password: PASSWORD }))).status).toBe(400);
  expect((await acceptInvite(req("POST", "/api/invitations/accept", { password: PASSWORD }))).status).toBe(400);
});

test("inviting someone who is already a member is rejected", async () => {
  const owner = await makeOwner();
  const other = await makeOwner("other@example.com");
  await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: other.user.id, role: "viewer" });
  const res = await invite(owner.cookie, "other@example.com");
  expect(res.status).toBe(409);
});

test("deleting the workspace removes its invitations", async () => {
  const { owner } = await invited();
  await db.delete(workspaces).where(eq(workspaces.id, owner.workspaceId));
  expect(await db.select().from(invitations)).toHaveLength(0);
});
