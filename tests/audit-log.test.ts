// @vitest-environment node
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, workspaces } from "@/db/schema";
import { recordAudit, stripAuditMetadata } from "@/lib/audit";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

/** Drizzle wraps driver errors ("Failed query"); the trigger's message is on `cause`. */
async function expectAppendOnly(run: Promise<unknown>) {
  const error = (await run.then(
    () => null,
    (e: unknown) => e,
  )) as { cause?: { message?: string; code?: string } } | null;
  expect(error?.cause?.message).toMatch(/append-only/);
  expect(error?.cause?.code).toBe("23001");
}

async function workspace(name = "Acme") {
  const [row] = await db.insert(workspaces).values({ name }).returning({ id: workspaces.id });
  return row.id;
}

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await pool.end();
});

describe("recordAudit", () => {
  it("appends an entry with actor, target, time and ip", async () => {
    const workspaceId = await workspace();
    const stored = await recordAudit(db, {
      workspaceId,
      actorLabel: "ana@example.com",
      action: "member.role_changed",
      targetType: "membership",
      targetId: "m-1",
      metadata: { from: "editor", to: "admin" },
      ip: "203.0.113.9",
    });
    expect(stored).toBe(true);
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      actorUserId: null,
      actorLabel: "ana@example.com",
      action: "member.role_changed",
      targetType: "membership",
      targetId: "m-1",
      metadata: { from: "editor", to: "admin" },
      ip: "203.0.113.9",
    });
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it("accepts an entry that belongs to no workspace", async () => {
    expect(await recordAudit(db, { workspaceId: null, actorLabel: "system", action: "job.ran" })).toBe(true);
    expect((await db.select().from(auditLog))[0].workspaceId).toBeNull();
  });

  it("works inside a transaction", async () => {
    const workspaceId = await workspace();
    await db.transaction(async (tx) => {
      await recordAudit(tx, { workspaceId, actorLabel: "ana", action: "export.created" });
    });
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it("strips denied keys at every depth, whatever the case", async () => {
    const workspaceId = await workspace();
    await recordAudit(db, {
      workspaceId,
      actorLabel: "ana",
      action: "settings.changed",
      metadata: {
        role: "admin",
        password: "hunter2",
        newPassword: "hunter3",
        Token: "abc",
        client_secret: "s",
        apiKey: "k",
        noteBody: "private",
        text: "a question",
        nested: { text: "x", fine: 1, list: [{ secret: "y", id: "z" }] },
      },
    });
    const [row] = await db.select().from(auditLog);
    expect(row.metadata).toEqual({ role: "admin", nested: { fine: 1, list: [{ id: "z" }] } });
    expect(JSON.stringify(row.metadata)).not.toMatch(/hunter|abc|private|question/);
  });

  it("drops values that are not plain JSON", () => {
    expect(stripAuditMetadata({ a: undefined, b: () => 1, c: 2, d: null })).toEqual({ c: 2, d: null });
  });

  it("logs a failed write without its content and does not throw", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      insert: () => {
        throw new Error("boom: secret note text");
      },
    };
    const stored = await recordAudit(broken as never, {
      workspaceId: null,
      actorLabel: "ana@example.com",
      action: "event.deleted",
      metadata: { reason: "private" },
    });
    expect(stored).toBe(false);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("event.deleted");
    expect(logged).not.toMatch(/secret note text|private|ana@example\.com/);
    spy.mockRestore();
  });

  it("returns false when the database refuses the row", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // workspace_id points at nothing: the foreign key rejects it
    const stored = await recordAudit(db, {
      workspaceId: "00000000-0000-4000-8000-000000000000",
      actorLabel: "ana",
      action: "x",
    });
    expect(stored).toBe(false);
    spy.mockRestore();
  });
});

describe("append-only triggers", () => {
  async function seeded() {
    const workspaceId = await workspace();
    await recordAudit(db, { workspaceId, actorLabel: "ana", action: "login" });
    await recordAudit(db, { workspaceId: null, actorLabel: "system", action: "job.ran" });
    return workspaceId;
  }

  it("rejects UPDATE", async () => {
    await seeded();
    await expectAppendOnly(Promise.resolve(db.update(auditLog).set({ action: "other" })));
    await expectAppendOnly(db.execute(sql`UPDATE audit_log SET ip = '1.1.1.1'`));
  });

  it("rejects DELETE, with or without a workspace", async () => {
    const workspaceId = await seeded();
    await expectAppendOnly(Promise.resolve(db.delete(auditLog).where(eq(auditLog.workspaceId, workspaceId))));
    await expectAppendOnly(db.execute(sql`DELETE FROM audit_log WHERE workspace_id IS NULL`));
    expect(await db.select().from(auditLog)).toHaveLength(2);
  });

  it("rejects DELETE of a row whose workspace still exists, even in a transaction that deletes another", async () => {
    const workspaceId = await seeded();
    const other = await workspace("Other");
    await expectAppendOnly(
      db.transaction(async (tx) => {
        await tx.delete(workspaces).where(eq(workspaces.id, other));
        await tx.delete(auditLog).where(eq(auditLog.workspaceId, workspaceId));
      }),
    );
  });

  it("removes a workspace's entries when the workspace is deleted, and only those", async () => {
    const workspaceId = await seeded();
    const other = await workspace("Other");
    await recordAudit(db, { workspaceId: other, actorLabel: "bo", action: "login" });
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    const left = await db.select().from(auditLog);
    expect(left.map((r) => r.workspaceId).sort()).toEqual([null, other].sort());
  });
});
