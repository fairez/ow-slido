// @vitest-environment node
import { readdirSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { events, interactions, memberships, users, workspaces } from "@/db/schema";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();
afterAll(() => pool.end());
beforeEach(() => truncateAll(db));

const when = { startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) };

describe("workspaces and memberships", () => {
  it("names a personal workspace after the email prefix and makes the user its owner", async () => {
    const [u] = await db.insert(users).values({ email: "ana.b@example.com", passwordHash: "h" }).returning();
    const ws = await createPersonalWorkspace(db, u);
    expect(ws.name).toBe("ana.b");
    const rows = await db.select().from(memberships).where(eq(memberships.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: ws.id, role: "owner", status: "active" });
  });

  it("allows one membership per user and workspace, and only known roles", async () => {
    const [u] = await db.insert(users).values({ email: "a@b.co", passwordHash: "h" }).returning();
    const [ws] = await db.insert(workspaces).values({ name: "w" }).returning();
    await db.insert(memberships).values({ workspaceId: ws.id, userId: u.id, role: "viewer" });
    await expect(db.insert(memberships).values({ workspaceId: ws.id, userId: u.id, role: "editor" })).rejects.toThrow();
    const [u2] = await db.insert(users).values({ email: "c@b.co", passwordHash: "h" }).returning();
    await expect(
      db.insert(memberships).values({ workspaceId: ws.id, userId: u2.id, role: "boss" as "owner" }),
    ).rejects.toThrow();
  });

  it("defaults the new user columns", async () => {
    const [u] = await db.insert(users).values({ email: "a@b.co", passwordHash: "h" }).returning();
    expect(u.mustChangePassword).toBe(false);
    expect(u.lastLoginAt).toBeNull();
  });

  it("deleting a workspace removes memberships, events and everything below them", async () => {
    const [u] = await db.insert(users).values({ email: "a@b.co", passwordHash: "h" }).returning();
    const ws = await createPersonalWorkspace(db, u);
    const [ev] = await db
      .insert(events)
      .values({ ownerId: u.id, workspaceId: ws.id, name: "E", joinCode: "1234", ...when })
      .returning();
    await db.insert(interactions).values({ eventId: ev.id, type: "poll", title: "P", state: "draft", position: 0, config: {} });

    await db.delete(workspaces).where(eq(workspaces.id, ws.id));

    expect(await db.select().from(memberships)).toHaveLength(0);
    expect(await db.select().from(events)).toHaveLength(0);
    expect(await db.select().from(interactions)).toHaveLength(0);
    expect(await db.select().from(users)).toHaveLength(1);
  });
});

describe("migration 0019 on seeded data", () => {
  const schema = "mig_rehearsal";

  // CREATE DATABASE is not allowed for the test role, so the rehearsal runs in its own schema.
  it("gives every user a workspace and owner membership and moves every event into it", async () => {
    const files = readMigrationFiles({ migrationsFolder: path.resolve("db/migrations") });
    const names = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
    const idx = names.findIndex((f) => f.startsWith("0019_"));
    expect(idx).toBeGreaterThan(0);

    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    const run = async (migration: (typeof files)[number]) => {
      for (const statement of migration.sql) await pool.query(statement.replaceAll('"public".', `"${schema}".`));
    };
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.query(`CREATE SCHEMA ${schema}`);
      for (const m of files.slice(0, idx)) await run(m);

      await pool.query(`insert into users (id, email, password_hash) values
        ('00000000-0000-0000-0000-000000000001', 'ana@example.com', 'h'),
        ('00000000-0000-0000-0000-000000000002', 'budi@example.com', 'h'),
        ('00000000-0000-0000-0000-000000000003', 'cici@example.com', 'h')`);
      await pool.query(`insert into events (id, owner_id, name, starts_at, ends_at, join_code) values
        ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'A1', now(), now(), '1111'),
        ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'A2', now(), now(), '2222'),
        ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'B1', now(), now(), '3333')`);

      await run(files[idx]);

      const ws = await pool.query(`select name from workspaces order by name`);
      expect(ws.rows.map((r) => r.name)).toEqual(["ana", "budi", "cici"]);
      const mem = await pool.query(`select role, status from memberships`);
      expect(mem.rows).toHaveLength(3);
      expect(mem.rows.every((r) => r.role === "owner" && r.status === "active")).toBe(true);
      const ev = await pool.query(
        `select e.name, w.name as ws from events e join workspaces w on w.id = e.workspace_id
         join memberships m on m.workspace_id = w.id and m.user_id = e.owner_id order by e.name`,
      );
      expect(ev.rows).toEqual([
        { name: "A1", ws: "ana" },
        { name: "A2", ws: "ana" },
        { name: "B1", ws: "budi" },
      ]);
      const cols = await pool.query(
        `select column_name from information_schema.columns where table_schema = $1 and table_name = 'workspaces'`,
        [schema],
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["created_at", "id", "name"]);
      const nullable = await pool.query(
        `select is_nullable from information_schema.columns
         where table_schema = $1 and table_name = 'events' and column_name = 'workspace_id'`,
        [schema],
      );
      expect(nullable.rows[0].is_nullable).toBe("NO");
      const login = await pool.query(`select must_change_password, last_login_at from users limit 1`);
      expect(login.rows[0]).toEqual({ must_change_password: false, last_login_at: null });
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  }, 60_000);
});
