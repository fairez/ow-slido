// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, memberships, templateItems, templates, users, workspaceExports, workspaces } from "@/db/schema";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth/session";
import { createParticipantToken } from "@/lib/participant-token";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";
import { seedFullEvent } from "./helpers/seed-event";
import { readZip } from "./helpers/zip";

const { db, pool } = createTestDb();
const HOUR = 60 * 60 * 1000;

type Ctx<P> = { params: Promise<P> };
let lib: typeof import("@/lib/workspace-export");
let postRoute: (req: Request) => Promise<Response>;
let statusRoute: (req: Request, ctx: Ctx<{ id: string }>) => Promise<Response>;
let downloadRoute: (req: Request, ctx: Ctx<{ id: string }>) => Promise<Response>;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  process.env.PARTICIPANT_TOKEN_SECRET ||= "test-participant-secret";
  lib = await import("@/lib/workspace-export");
  postRoute = (await import("@/app/api/workspace/export/route")).POST;
  statusRoute = (await import("@/app/api/workspace/export/[id]/route")).GET;
  downloadRoute = (await import("@/app/api/workspace/export/[id]/download/route")).GET;
});
beforeEach(() => truncateAll(db));
afterAll(() => pool.end());

const PASSWORD_HASH = "scrypt$sentinel-password-hash";

async function makeUser(email: string) {
  const [user] = await db.insert(users).values({ email, passwordHash: PASSWORD_HASH, emailVerifiedAt: new Date() }).returning();
  const workspace = await createPersonalWorkspace(db, user);
  await setPlan(db, workspace.id, "team");
  return { user, workspaceId: workspace.id, cookie: `${SESSION_COOKIE}=${createSessionToken(user.id)}` };
}

const req = (method: string, cookie: string | null, url = "http://localhost/api/workspace/export") =>
  new Request(url, { method, headers: { ...(cookie ? { cookie } : {}), "x-real-ip": "203.0.113.77" } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function setup() {
  const owner = await makeUser("owner@example.com");
  const seeded = await seedFullEvent(db, owner.workspaceId, owner.user.id);
  const [tpl] = await db.insert(templates).values({ workspaceId: owner.workspaceId, name: "Kickoff", kind: "interaction", createdBy: owner.user.id }).returning();
  await db.insert(templateItems).values({ templateId: tpl.id, position: 0, type: "poll", title: "Lunch?", config: { prompt: "Lunch?" } });
  return { owner, ...seeded };
}

async function finishedExport(workspaceId: string, userId: string, now = new Date()) {
  const request = await lib.requestWorkspaceExport({ workspaceId, userId });
  if (!request.ok) throw new Error("export was refused");
  await lib.runWorkspaceExport(request.exportId, { now });
  return request.exportId;
}

describe("buildWorkspaceZip", () => {
  it("holds per-event CSVs, templates, members and the plan", async () => {
    const { owner, event } = await setup();
    const [editor] = await db.insert(users).values({ email: "editor@example.com", passwordHash: "x" }).returning();
    await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: editor.id, role: "editor" });

    const files = readZip(await lib.buildWorkspaceZip(owner.workspaceId));
    const names = Object.keys(files);

    const csvs = names.filter((n) => n.startsWith("events/01-Town-hall/") && n.endsWith(".csv"));
    expect(csvs).toHaveLength(9);
    expect(csvs).toContain("events/01-Town-hall/01-poll.csv");
    expect(JSON.parse(files["events/01-Town-hall/event.json"])).toMatchObject({ name: event.name });

    expect(files["members.csv"].split("\r\n")).toEqual(["email,role", "owner@example.com,owner", "editor@example.com,editor", ""]);
    const exportedTemplates = JSON.parse(files["templates.json"]);
    expect(exportedTemplates).toHaveLength(1);
    expect(exportedTemplates[0]).toMatchObject({ name: "Kickoff", items: [{ type: "poll", title: "Lunch?", config: { prompt: "Lunch?" } }] });
    expect(JSON.parse(files["plan.json"])).toMatchObject({ plan: "team" });
  });

  it("does not contain participant tokens or ids, IPs or password hashes", async () => {
    const { owner, event, a, b } = await setup();
    await postRoute(req("POST", owner.cookie)); // leaves an audit entry with the caller's IP in the database
    const zip = await lib.buildWorkspaceZip(owner.workspaceId);
    const text = zip.toString("latin1");
    // The archive is stored uncompressed, so a needle that is in it would be found.
    expect(text).toContain("owner@example.com");
    expect(text).toContain("ayu says");

    const forbidden = [
      PASSWORD_HASH,
      "passwordHash",
      "203.0.113.77",
      createParticipantToken(event.id, a.id),
      createParticipantToken(event.id, b.id),
      a.id,
      b.id,
      owner.user.id,
    ];
    for (const needle of forbidden) expect(text, needle).not.toContain(needle);
    expect(await db.select().from(auditLog).where(eq(auditLog.workspaceId, owner.workspaceId))).not.toHaveLength(0);
  });

  it("leaves other workspaces out", async () => {
    const { owner } = await setup();
    const other = await makeUser("other@example.com");
    await seedFullEvent(db, other.workspaceId, other.user.id);
    const files = readZip(await lib.buildWorkspaceZip(owner.workspaceId));
    expect(Object.keys(files).filter((n) => n.startsWith("events/") && n.endsWith("/event.json"))).toHaveLength(1);
    expect(files["members.csv"]).not.toContain("other@example.com");
  });
});

describe("export job", () => {
  it("goes queued -> running -> done and keeps the file for 24 hours", async () => {
    const { owner } = await setup();
    const request = await lib.requestWorkspaceExport({ workspaceId: owner.workspaceId, userId: owner.user.id });
    if (!request.ok) throw new Error("refused");
    expect((await lib.getWorkspaceExport(request.exportId, owner.workspaceId))?.status).toBe("queued");

    const now = new Date("2030-02-01T10:00:00Z");
    await lib.runWorkspaceExport(request.exportId, { now });
    const done = await lib.getWorkspaceExport(request.exportId, owner.workspaceId);
    expect(done?.status).toBe("done");
    expect(done?.sizeBytes).toBeGreaterThan(0);
    expect(done?.expiresAt?.toISOString()).toBe(new Date(now.getTime() + 24 * HOUR).toISOString());
  });

  it("records a failure with a code and no file", async () => {
    const { owner } = await setup();
    const request = await lib.requestWorkspaceExport({ workspaceId: owner.workspaceId, userId: owner.user.id });
    if (!request.ok) throw new Error("refused");
    await lib.runWorkspaceExport(request.exportId, {
      build: async () => {
        throw new Error("secret note text that must not be stored");
      },
    });
    const [row] = await db.select().from(workspaceExports);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("build_failed");
    expect(row.zip).toBeNull();
  });

  it("retries a failing build with backoff, then records the attempts and the error class only", async () => {
    const { owner } = await setup();
    const request = await lib.requestWorkspaceExport({ workspaceId: owner.workspaceId, userId: owner.user.id });
    if (!request.ok) throw new Error("refused");
    const slept: number[] = [];
    let calls = 0;
    await lib.runWorkspaceExport(request.exportId, {
      delays: [5, 10, 15],
      sleep: async (ms) => void slept.push(ms),
      build: async () => {
        calls += 1;
        throw Object.assign(new Error("secret note text that must not be stored"), { code: "ECONNRESET" });
      },
    });
    expect(calls).toBe(4);
    expect(slept).toEqual([5, 10, 15]);
    const [row] = await db.select().from(workspaceExports);
    expect(row).toMatchObject({ status: "failed", error: "build_failed", attempts: 4, errorClass: "Error:ECONNRESET", zip: null });
    expect(JSON.stringify({ ...row, zip: null })).not.toContain("secret note text");
  });

  it("finishes when a retry succeeds", async () => {
    const { owner } = await setup();
    const request = await lib.requestWorkspaceExport({ workspaceId: owner.workspaceId, userId: owner.user.id });
    if (!request.ok) throw new Error("refused");
    let calls = 0;
    await lib.runWorkspaceExport(request.exportId, {
      delays: [0, 0, 0],
      build: async () => {
        calls += 1;
        if (calls < 2) throw new Error("flaky");
        return Buffer.from("zip");
      },
    });
    const [row] = await db.select().from(workspaceExports);
    expect(row).toMatchObject({ status: "done", attempts: 2, errorClass: null });
  });

  it("allows one queued or running export per workspace", async () => {
    const { owner } = await setup();
    const first = await lib.requestWorkspaceExport({ workspaceId: owner.workspaceId, userId: owner.user.id });
    const second = await lib.requestWorkspaceExport({ workspaceId: owner.workspaceId, userId: owner.user.id });
    if (!first.ok) throw new Error("refused");
    expect(second).toEqual({ ok: false, reason: "running", exportId: first.exportId });

    const other = await makeUser("other@example.com");
    expect((await lib.requestWorkspaceExport({ workspaceId: other.workspaceId, userId: other.user.id })).ok).toBe(true);

    await lib.runWorkspaceExport(first.exportId);
    expect((await lib.requestWorkspaceExport({ workspaceId: owner.workspaceId, userId: owner.user.id })).ok).toBe(true);
  });

  it("removes the file after 24 hours", async () => {
    const { owner } = await setup();
    const start = new Date("2030-02-01T10:00:00Z");
    const id = await finishedExport(owner.workspaceId, owner.user.id, start);

    await lib.sweepWorkspaceExports(new Date(start.getTime() + 23 * HOUR));
    expect((await db.select().from(workspaceExports))[0].zip).not.toBeNull();

    await lib.sweepWorkspaceExports(new Date(start.getTime() + 25 * HOUR));
    const [row] = await db.select().from(workspaceExports);
    expect(row.zip).toBeNull();
    expect((await lib.getWorkspaceExport(id, owner.workspaceId))?.status).toBe("expired");
  });

  it("fails the exports a restart interrupted", async () => {
    const { owner } = await setup();
    const request = await lib.requestWorkspaceExport({ workspaceId: owner.workspaceId, userId: owner.user.id });
    if (!request.ok) throw new Error("refused");
    await lib.failInterruptedWorkspaceExports();
    const [row] = await db.select().from(workspaceExports);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("interrupted");
    expect((await lib.requestWorkspaceExport({ workspaceId: owner.workspaceId, userId: owner.user.id })).ok).toBe(true);
  });

  it("is removed with the workspace", async () => {
    const { owner } = await setup();
    await finishedExport(owner.workspaceId, owner.user.id);
    await db.delete(workspaces).where(eq(workspaces.id, owner.workspaceId));
    expect(await db.select().from(workspaceExports)).toHaveLength(0);
  });
});

describe("download links", () => {
  it("verify for their own export until they expire, and not after a change", () => {
    const now = new Date("2030-02-01T10:00:00Z");
    const link = lib.signDownloadLink("export-1", now);
    const { expires, sig } = Object.fromEntries(new URL(link, "http://x").searchParams) as { expires: string; sig: string };
    expect(lib.verifyDownloadLink("export-1", expires, sig, now)).toBe(true);
    expect(lib.verifyDownloadLink("export-2", expires, sig, now)).toBe(false);
    expect(lib.verifyDownloadLink("export-1", String(Number(expires) + 1), sig, now)).toBe(false);
    expect(lib.verifyDownloadLink("export-1", expires, sig, new Date(Number(expires) + 1))).toBe(false);
  });
});

describe("routes", () => {
  async function waitDone(cookie: string, id: string) {
    for (let i = 0; i < 100; i++) {
      const body = await (await statusRoute(req("GET", cookie), ctx(id))).json();
      if (body.status === "done" || body.status === "failed") return body;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("export did not finish");
  }

  it("starts a job for the owner, reports its status and serves the file through a short-lived link", async () => {
    const { owner } = await setup();
    const res = await postRoute(req("POST", owner.cookie));
    expect(res.status).toBe(202);
    const { id } = await res.json();

    const status = await waitDone(owner.cookie, id);
    expect(status.status).toBe("done");
    expect(status.downloadUrl).toMatch(new RegExp(`^/api/workspace/export/${id}/download\\?expires=\\d+&sig=`));
    expect(status).not.toHaveProperty("zip");

    const file = await downloadRoute(req("GET", owner.cookie, `http://localhost${status.downloadUrl}`), ctx(id));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/zip");
    expect(file.headers.get("content-disposition")).toMatch(/attachment; filename="workspace-export-\d{4}-\d{2}-\d{2}\.zip"/);
    expect(Object.keys(readZip(Buffer.from(await file.arrayBuffer())))).toContain("plan.json");

    const actions = (await db.select().from(auditLog)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["workspace.export_requested", "workspace.export_downloaded"]));
  });

  it("answers 409 with the running export while one is queued", async () => {
    const { owner } = await setup();
    const running = await lib.requestWorkspaceExport({ workspaceId: owner.workspaceId, userId: owner.user.id });
    if (!running.ok) throw new Error("refused");
    const res = await postRoute(req("POST", owner.cookie));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "export_running", id: running.exportId });
  });

  it("is for owners only", async () => {
    const { owner } = await setup();
    const [admin] = await db.insert(users).values({ email: "admin@example.com", passwordHash: "x", emailVerifiedAt: new Date() }).returning();
    await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: admin.id, role: "admin" });
    const adminCookie = `${SESSION_COOKIE}=${createSessionToken(admin.id)}`;

    expect((await postRoute(req("POST", adminCookie))).status).toBe(403);
    expect((await postRoute(req("POST", null))).status).toBe(401);
    expect(await db.select().from(workspaceExports)).toHaveLength(0);

    const id = await finishedExport(owner.workspaceId, owner.user.id);
    expect((await statusRoute(req("GET", adminCookie), ctx(id))).status).toBe(403);
  });

  it("hides another workspace's export", async () => {
    const { owner } = await setup();
    const other = await makeUser("other@example.com");
    const id = await finishedExport(owner.workspaceId, owner.user.id);
    expect((await statusRoute(req("GET", other.cookie), ctx(id))).status).toBe(404);
    const link = lib.signDownloadLink(id);
    expect((await downloadRoute(req("GET", other.cookie, `http://localhost${link}`), ctx(id))).status).toBe(404);
  });

  it("refuses a download without a valid link or after the file was removed", async () => {
    const { owner } = await setup();
    const start = new Date("2030-02-01T10:00:00Z");
    const id = await finishedExport(owner.workspaceId, owner.user.id, start);
    const base = `http://localhost/api/workspace/export/${id}/download`;

    expect((await downloadRoute(req("GET", owner.cookie, base), ctx(id))).status).toBe(403);
    expect((await downloadRoute(req("GET", owner.cookie, `${base}?expires=${Date.now() + 1000}&sig=bad`), ctx(id))).status).toBe(403);

    await lib.sweepWorkspaceExports(new Date(start.getTime() + 25 * HOUR));
    const res = await downloadRoute(req("GET", owner.cookie, `http://localhost${lib.signDownloadLink(id)}`), ctx(id));
    expect(res.status).toBe(410);
  });

  it("never offers a link before the job is done", async () => {
    const { owner } = await setup();
    const queued = await lib.requestWorkspaceExport({ workspaceId: owner.workspaceId, userId: owner.user.id });
    if (!queued.ok) throw new Error("refused");
    const body = await (await statusRoute(req("GET", owner.cookie), ctx(queued.exportId))).json();
    expect(body.status).toBe("queued");
    expect(body.downloadUrl).toBeNull();
    const res = await downloadRoute(req("GET", owner.cookie, `http://localhost${lib.signDownloadLink(queued.exportId)}`), ctx(queued.exportId));
    expect(res.status).toBe(409);
  });
});
