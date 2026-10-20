// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, events, memberships, participants, users, workspaces } from "@/db/schema";
import { createSessionToken } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { clearOutbox, getOutbox, resetEmailSender } from "@/lib/email";
import { runRetention } from "@/lib/retention";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, setPlan, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Handler = (req: Request) => Promise<Response>;
let retentionRoute: { GET: Handler; PATCH: Handler };

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  retentionRoute = await import("@/app/api/workspaces/active/retention/route");
});

beforeEach(async () => {
  vi.stubEnv("EMAIL_PROVIDER", "log");
  resetEmailSender();
  clearOutbox();
  await truncateAll(db);
});
afterAll(() => pool.end());

const DAY = 24 * 60 * 60 * 1000;
const ENDED = new Date("2026-01-01T12:00:00Z");
const at = (days: number) => new Date(ENDED.getTime() + days * DAY);

async function makeUser(email: string) {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword("a long password"), emailVerifiedAt: new Date() })
    .returning();
  const workspace = await createPersonalWorkspace(db, user);
  return { user, workspaceId: workspace.id, cookie: `session=${createSessionToken(user.id)}` };
}

async function makeEvent(owner: Awaited<ReturnType<typeof makeUser>>, name: string, endsAt = ENDED) {
  const [event] = await db
    .insert(events)
    .values({
      ownerId: owner.user.id,
      workspaceId: owner.workspaceId,
      name,
      startsAt: new Date(endsAt.getTime() - 3600_000),
      endsAt,
      joinCode: String(Math.floor(1000 + Math.random() * 8999)),
    })
    .returning();
  return event;
}

const setDays = (workspaceId: string, retentionDays: number | null) =>
  db.update(workspaces).set({ retentionDays }).where(eq(workspaces.id, workspaceId));
const eventIds = async () => (await db.select({ id: events.id }).from(events)).map((row) => row.id);
const patch = (cookie: string, body: unknown) =>
  retentionRoute.PATCH(
    new Request("http://localhost/x", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-real-ip": "10.0.0.9", cookie },
      body: JSON.stringify(body),
    }),
  );

describe("runRetention", () => {
  it("does nothing when retention is null", async () => {
    const owner = await makeUser("owner@example.com");
    const event = await makeEvent(owner, "Old");
    expect(await runRetention(db, at(2000))).toEqual({ warned: 0, deleted: 0 });
    expect(await eventIds()).toEqual([event.id]);
    expect(getOutbox()).toHaveLength(0);
    expect((await db.select().from(events))[0].deletionNoticeSentAt).toBeNull();
  });

  it("leaves an event alone before the warning window", async () => {
    const owner = await makeUser("owner@example.com");
    await setDays(owner.workspaceId, 30);
    const event = await makeEvent(owner, "Recent");
    expect(await runRetention(db, at(22))).toEqual({ warned: 0, deleted: 0 });
    expect(await eventIds()).toEqual([event.id]);
    expect(getOutbox()).toHaveLength(0);
  });

  it("warns owners and admins once, 7 days before the delete date", async () => {
    const owner = await makeUser("owner@example.com");
    const admin = await makeUser("admin@example.com");
    const editor = await makeUser("editor@example.com");
    const suspended = await makeUser("gone@example.com");
    await db.insert(memberships).values([
      { workspaceId: owner.workspaceId, userId: admin.user.id, role: "admin" },
      { workspaceId: owner.workspaceId, userId: editor.user.id, role: "editor" },
      { workspaceId: owner.workspaceId, userId: suspended.user.id, role: "admin", status: "suspended" },
    ]);
    await setDays(owner.workspaceId, 30);
    const event = await makeEvent(owner, "Town hall");

    expect(await runRetention(db, at(23))).toEqual({ warned: 1, deleted: 0 });
    const mail = getOutbox();
    expect(mail.map((m) => m.to).sort()).toEqual(["admin@example.com", "owner@example.com"]);
    expect(mail[0].subject).toContain("Town hall");
    expect(mail[0].subject).toContain("2026-01-31");
    expect(mail[0].text).toContain("2026-01-31");
    expect((await db.select().from(events).where(eq(events.id, event.id)))[0].deletionNoticeSentAt).toEqual(at(23));

    clearOutbox();
    expect(await runRetention(db, at(24))).toEqual({ warned: 0, deleted: 0 });
    expect(getOutbox()).toHaveLength(0);
    expect(await eventIds()).toEqual([event.id]);
  });

  it("deletes after the period with all its data and writes an audit entry without content", async () => {
    const owner = await makeUser("owner@example.com");
    await setDays(owner.workspaceId, 30);
    const old = await makeEvent(owner, "Secret launch");
    const fresh = await makeEvent(owner, "Next month", at(20));
    await db.insert(participants).values({ eventId: old.id });

    await runRetention(db, at(23));
    expect(await runRetention(db, at(29))).toEqual({ warned: 0, deleted: 0 });
    expect(await eventIds()).toContain(old.id);

    expect(await runRetention(db, at(30))).toMatchObject({ deleted: 1 });
    expect(await eventIds()).toEqual([fresh.id]);
    expect(await db.select().from(participants)).toHaveLength(0);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "event.retention_deleted"));
    expect(entry).toMatchObject({
      workspaceId: owner.workspaceId,
      actorLabel: "system",
      targetType: "event",
      targetId: old.id,
      metadata: { retentionDays: 30 },
    });
    expect(JSON.stringify(entry)).not.toContain("Secret launch");
  });

  it("warns first and waits a full notice period for an event that is already past due", async () => {
    const owner = await makeUser("owner@example.com");
    await setDays(owner.workspaceId, 30);
    const event = await makeEvent(owner, "Ancient");

    expect(await runRetention(db, at(100))).toEqual({ warned: 1, deleted: 0 });
    expect(getOutbox()[0].text).toContain(at(107).toISOString().slice(0, 10));
    expect(await runRetention(db, at(106))).toEqual({ warned: 0, deleted: 0 });
    expect(await eventIds()).toEqual([event.id]);
    expect(await runRetention(db, at(107))).toEqual({ warned: 0, deleted: 1 });
    expect(await eventIds()).toEqual([]);
  });

  it("only touches workspaces that set a period", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    await setDays(a.workspaceId, 30);
    await makeEvent(a, "A");
    const kept = await makeEvent(b, "B");
    await runRetention(db, at(23));
    await runRetention(db, at(40));
    expect(await eventIds()).toEqual([kept.id]);
  });

  it("does not delete when the warning could not be sent to anyone", async () => {
    const owner = await makeUser("owner@example.com");
    await setDays(owner.workspaceId, 30);
    const event = await makeEvent(owner, "E");
    const sender = (await import("@/lib/email")).getEmailSender();
    const spy = vi.spyOn(sender, "send").mockRejectedValue(new Error("smtp down"));
    expect(await runRetention(db, at(23))).toEqual({ warned: 0, deleted: 0 });
    expect((await db.select().from(events).where(eq(events.id, event.id)))[0].deletionNoticeSentAt).toBeNull();
    spy.mockRestore();
    expect(await runRetention(db, at(24))).toEqual({ warned: 1, deleted: 0 });
  });
});

describe("PATCH /api/workspaces/active/retention", () => {
  it("lets an owner set 30, 90, 365 or null and audits each change", async () => {
    const owner = await makeUser("owner@example.com");
    for (const days of [90, 365, 30, null]) {
      const res = await patch(owner.cookie, { retentionDays: days });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ retentionDays: days });
    }
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "workspace.settings_changed"));
    expect(rows.map((row) => row.metadata)).toEqual([
      { setting: "retention_days", from: null, to: 90 },
      { setting: "retention_days", from: 90, to: 365 },
      { setting: "retention_days", from: 365, to: 30 },
      { setting: "retention_days", from: 30, to: null },
    ]);
    expect(await patch(owner.cookie, { retentionDays: null })).toMatchObject({ status: 200 });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "workspace.settings_changed"))).toHaveLength(4);
  });

  it("rejects other values and a missing field", async () => {
    const owner = await makeUser("owner@example.com");
    for (const body of [{ retentionDays: 7 }, { retentionDays: "30" }, { retentionDays: 0 }, {}, { retentionDays: undefined }]) {
      expect((await patch(owner.cookie, body)).status).toBe(400);
    }
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, owner.workspaceId));
    expect(row.retentionDays).toBeNull();
  });

  it("needs members.manage", async () => {
    const owner = await makeUser("owner@example.com");
    const editor = await makeUser("editor@example.com");
    await db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: editor.user.id, role: "editor" });
    const res = await retentionRoute.PATCH(
      new Request("http://localhost/x", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: `${editor.cookie}; workspace=${owner.workspaceId}` },
        body: JSON.stringify({ retentionDays: 30 }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await patch("", { retentionDays: 30 })).status).toBe(401);
  });

  it("clears earlier warnings when the period changes, so a shorter period warns again", async () => {
    const owner = await makeUser("owner@example.com");
    await setPlan(db, owner.workspaceId, "free");
    await patch(owner.cookie, { retentionDays: 365 });
    const event = await makeEvent(owner, "E");
    await runRetention(db, at(400));
    expect((await db.select().from(events).where(eq(events.id, event.id)))[0].deletionNoticeSentAt).not.toBeNull();

    await patch(owner.cookie, { retentionDays: 30 });
    expect((await db.select().from(events).where(eq(events.id, event.id)))[0].deletionNoticeSentAt).toBeNull();
    // Same value again: nothing is reset.
    await db.update(events).set({ deletionNoticeSentAt: at(400) });
    await patch(owner.cookie, { retentionDays: 30 });
    expect((await db.select().from(events).where(eq(events.id, event.id)))[0].deletionNoticeSentAt).toEqual(at(400));
  });

  it("reads the current value", async () => {
    const owner = await makeUser("owner@example.com");
    await patch(owner.cookie, { retentionDays: 90 });
    const res = await retentionRoute.GET(new Request("http://localhost/x", { headers: { cookie: owner.cookie } }));
    expect(await res.json()).toEqual({ retentionDays: 90 });
  });
});
