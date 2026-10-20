// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoveryCodes, userTotp, users } from "@/db/schema";
import {
  TwoFactorAlreadyEnabledError,
  TwoFactorNotConfiguredError,
  TWOFA_ATTEMPT_LIMIT,
  beginEnrolment,
  confirmEnrolment,
  decryptSecret,
  encryptSecret,
  getTwoFactorStatus,
  isTwoFactorConfigured,
  remainingRecoveryCodes,
  verifyRecoveryCode,
  verifyTotpCode,
} from "@/lib/auth/two-factor";
import { totp } from "@/lib/auth/totp";
import { getRateLimitStore } from "@/lib/rate-limit";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();
afterAll(() => pool.end());

const KEY = "a".repeat(64);

beforeEach(async () => {
  vi.stubEnv("TWOFA_ENCRYPTION_KEY", KEY);
  await truncateAll(db);
  await getRateLimitStore().reset();
});
afterEach(() => vi.unstubAllEnvs());

async function user(email = "a@example.com") {
  const [u] = await db.insert(users).values({ email, passwordHash: "h" }).returning();
  return u;
}

async function enrolled() {
  const u = await user();
  const { secret } = await beginEnrolment(db, u, "OW Slido");
  const now = Date.now();
  const result = await confirmEnrolment(db, u.id, totp(secret, now), now);
  if (!result.ok) throw new Error("enrolment failed");
  return { u, secret, codes: result.recoveryCodes, now };
}

describe("secret encryption", () => {
  it("round-trips and does not store the plain secret", () => {
    const stored = encryptSecret("JBSWY3DPEHPK3PXP");
    expect(stored).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(stored)).toBe("JBSWY3DPEHPK3PXP");
    expect(encryptSecret("JBSWY3DPEHPK3PXP")).not.toBe(stored);
  });

  it("fails on a tampered value or another key", () => {
    const stored = encryptSecret("JBSWY3DPEHPK3PXP");
    const [iv, tag, data] = stored.split(".");
    const flipped = `${iv}.${tag}.${data.startsWith("A") ? "B" : "A"}${data.slice(1)}`;
    expect(() => decryptSecret(flipped)).toThrow();
    vi.stubEnv("TWOFA_ENCRYPTION_KEY", "b".repeat(64));
    expect(() => decryptSecret(stored)).toThrow();
  });

  it("accepts a base64 key and refuses a missing or short one", () => {
    vi.stubEnv("TWOFA_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    expect(decryptSecret(encryptSecret("X"))).toBe("X");
    vi.stubEnv("TWOFA_ENCRYPTION_KEY", "");
    expect(isTwoFactorConfigured()).toBe(false);
    expect(() => encryptSecret("X")).toThrow(TwoFactorNotConfiguredError);
    vi.stubEnv("TWOFA_ENCRYPTION_KEY", "abcd");
    expect(isTwoFactorConfigured()).toBe(false);
  });
});

describe("enrolment", () => {
  it("refuses to start when the key is unset", async () => {
    const u = await user();
    vi.stubEnv("TWOFA_ENCRYPTION_KEY", "");
    await expect(beginEnrolment(db, u, "OW Slido")).rejects.toThrow(TwoFactorNotConfiguredError);
    expect(await db.select().from(userTotp)).toHaveLength(0);
  });

  it("is not enabled until the first code is confirmed, and stores the secret encrypted", async () => {
    const u = await user();
    const { secret, uri } = await beginEnrolment(db, u, "OW Slido");
    expect(uri).toContain(`secret=${secret}`);
    expect(await getTwoFactorStatus(db, u.id)).toEqual({ enabled: false, pending: true });
    const [row] = await db.select().from(userTotp);
    expect(row.secretEncrypted).not.toContain(secret);

    expect(await confirmEnrolment(db, u.id, "000000")).toEqual({ ok: false, reason: "invalid" });
    expect(await getTwoFactorStatus(db, u.id)).toEqual({ enabled: false, pending: true });
    expect(await verifyTotpCode(db, u.id, totp(secret, Date.now()))).toEqual({ ok: false, reason: "not_enabled" });
  });

  it("restarting before confirmation replaces the secret; after confirmation it is refused", async () => {
    const u = await user();
    const first = await beginEnrolment(db, u, "OW Slido");
    const second = await beginEnrolment(db, u, "OW Slido");
    expect(second.secret).not.toBe(first.secret);
    expect(await db.select().from(userTotp)).toHaveLength(1);
    const now = Date.now();
    expect((await confirmEnrolment(db, u.id, totp(second.secret, now), now)).ok).toBe(true);
    await expect(beginEnrolment(db, u, "OW Slido")).rejects.toThrow(TwoFactorAlreadyEnabledError);
  });

  it("confirms with 10 recovery codes, stored only as hashes", async () => {
    const { u, codes } = await enrolled();
    expect(await getTwoFactorStatus(db, u.id)).toEqual({ enabled: true, pending: false });
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    const rows = await db.select().from(recoveryCodes);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      for (const code of codes) expect(row.codeHash).not.toContain(code.replace("-", ""));
      expect(row.usedAt).toBeNull();
    }
    // A second confirm cannot mint another set.
    expect((await confirmEnrolment(db, u.id, "123456")).ok).toBe(false);
  });
});

describe("verification", () => {
  it("accepts a current code and rejects a wrong one", async () => {
    const { u, secret, now } = await enrolled();
    expect(await verifyTotpCode(db, u.id, totp(secret, now), now)).toEqual({ ok: true });
    expect(await verifyTotpCode(db, u.id, totp(secret, now + 120_000), now)).toEqual({ ok: false, reason: "invalid" });
  });

  it("each recovery code works once, in any case and with or without the dash", async () => {
    const { u, codes } = await enrolled();
    expect(await verifyRecoveryCode(db, u.id, codes[0])).toEqual({ ok: true });
    expect(await verifyRecoveryCode(db, u.id, codes[0])).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyRecoveryCode(db, u.id, codes[1].toLowerCase().replace("-", ""))).toEqual({ ok: true });
    expect(await remainingRecoveryCodes(db, u.id)).toBe(8);
    expect(await verifyRecoveryCode(db, u.id, "")).toEqual({ ok: false, reason: "invalid" });
  });

  it("a recovery code does not work for another user", async () => {
    const { codes } = await enrolled();
    const other = await user("b@example.com");
    expect(await verifyRecoveryCode(db, other.id, codes[0])).toEqual({ ok: false, reason: "invalid" });
  });

  it("two concurrent uses of one recovery code succeed only once", async () => {
    const { u, codes } = await enrolled();
    const results = await Promise.all([verifyRecoveryCode(db, u.id, codes[2]), verifyRecoveryCode(db, u.id, codes[2])]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("limits attempts per user across code types, and not other users", async () => {
    const { u, secret, now } = await enrolled();
    // enrolment spent one attempt
    for (let i = 1; i < TWOFA_ATTEMPT_LIMIT; i++) {
      expect(await verifyTotpCode(db, u.id, "000000", now)).toEqual({ ok: false, reason: "invalid" });
    }
    const blocked = await verifyTotpCode(db, u.id, totp(secret, now), now);
    expect(blocked).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(await verifyRecoveryCode(db, u.id, "AAAAA-AAAAA")).toMatchObject({ ok: false, reason: "rate_limited" });
    const other = await enrolled2();
    expect(await verifyTotpCode(db, other.id, "000000")).toEqual({ ok: false, reason: "invalid" });
  });
});

async function enrolled2() {
  const u = await user("c@example.com");
  const { secret } = await beginEnrolment(db, u, "OW Slido");
  await confirmEnrolment(db, u.id, totp(secret, Date.now()));
  return u;
}

describe("cascade", () => {
  it("deleting the user removes the secret and recovery codes", async () => {
    const { u } = await enrolled();
    await db.delete(users).where(eq(users.id, u.id));
    expect(await db.select().from(userTotp)).toHaveLength(0);
    expect(await db.select().from(recoveryCodes)).toHaveLength(0);
  });
});
