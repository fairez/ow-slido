// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authTokens, users } from "@/db/schema";
import { consumeToken, issueToken } from "@/lib/auth/tokens";
import { clearOutbox, getEmailSender, getOutbox, resetEmailSender } from "@/lib/email";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();
afterAll(() => pool.end());
beforeEach(async () => {
  await truncateAll(db);
  clearOutbox();
});

async function user() {
  const [u] = await db.insert(users).values({ email: "a@example.com", passwordHash: "h" }).returning();
  return u;
}

describe("auth tokens", () => {
  it("consumes once and stores only the hash", async () => {
    const u = await user();
    const token = await issueToken(db, { userId: u.id, purpose: "verify_email", ttlMs: 60_000 });
    const [row] = await db.select().from(authTokens);
    expect(row.tokenHash).not.toContain(token);
    expect(await consumeToken(db, token, "verify_email")).toEqual({ userId: u.id });
    expect(await consumeToken(db, token, "verify_email")).toBeNull();
  });

  it("rejects expired, wrong-purpose and unknown tokens", async () => {
    const u = await user();
    const expired = await issueToken(db, { userId: u.id, purpose: "reset_password", ttlMs: -1000 });
    expect(await consumeToken(db, expired, "reset_password")).toBeNull();
    const token = await issueToken(db, { userId: u.id, purpose: "reset_password", ttlMs: 60_000 });
    expect(await consumeToken(db, token, "verify_email")).toBeNull();
    expect(await consumeToken(db, "nope", "reset_password")).toBeNull();
    expect(await consumeToken(db, token, "reset_password")).toEqual({ userId: u.id });
  });

  it("allows an invite token without a user, and cascades with the user", async () => {
    const token = await issueToken(db, { userId: null, purpose: "invite", ttlMs: 60_000 });
    expect(await consumeToken(db, token, "invite")).toEqual({ userId: null });
    const u = await user();
    await issueToken(db, { userId: u.id, purpose: "verify_email", ttlMs: 60_000 });
    await db.delete(users).where(eq(users.id, u.id));
    expect(await db.select().from(authTokens).where(eq(authTokens.userId, u.id))).toHaveLength(0);
  });
});

describe("email outbox", () => {
  it("captures messages from the log adapter by default", async () => {
    resetEmailSender();
    await getEmailSender().send({ to: "a@example.com", subject: "Hi", text: "body" });
    expect(getOutbox()).toEqual([{ to: "a@example.com", subject: "Hi", text: "body" }]);
    clearOutbox();
    expect(getOutbox()).toHaveLength(0);
  });
});
