import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { recoveryCodes, userTotp } from "@/db/schema";
import { rateLimit } from "@/lib/rate-limit";
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from "./totp";

type Db = ReturnType<typeof createDb>["db"];

export const RECOVERY_CODE_COUNT = 10;
export const TWOFA_ATTEMPT_LIMIT = 10;
export const TWOFA_ATTEMPT_WINDOW_SECONDS = 15 * 60;

export class TwoFactorNotConfiguredError extends Error {
  constructor() {
    super("TWOFA_ENCRYPTION_KEY is not set or is not 32 bytes (64 hex characters or base64)");
  }
}

/** Reads the key lazily so tests can stub it; accepts 64 hex characters or base64 of 32 bytes. */
function encryptionKey(): Buffer {
  const raw = process.env.TWOFA_ENCRYPTION_KEY?.trim();
  if (!raw) throw new TwoFactorNotConfiguredError();
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new TwoFactorNotConfiguredError();
  return key;
}

export function isTwoFactorConfigured(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

/** AES-256-GCM; the stored value is `iv.tag.ciphertext`, each base64url. */
export function encryptSecret(plain: string): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(stored: string): string {
  const key = encryptionKey();
  const [iv, tag, data] = stored.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z2-7]/g, "");

/** Keyed hash, so a leaked table cannot be brute-forced without the encryption key. */
function hashRecoveryCode(code: string): string {
  return createHmac("sha256", encryptionKey()).update(`recovery:${normalizeRecoveryCode(code)}`).digest("hex");
}

/** Ten codes shaped `ABCDE-FGHIJ` (50 bits each). Only the hashes are stored; the caller shows these once. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Replaces all of the user's recovery codes (used or not) with a fresh set and returns the plain codes. */
export async function replaceRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await tx.insert(recoveryCodes).values(codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })));
  });
  return codes;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "invalid" | "rate_limited" | "not_enabled"; retryAfterSeconds?: number };

/** Shared by TOTP and recovery attempts, so guessing across both is capped together. */
async function attemptAllowed(userId: string) {
  const result = await rateLimit(`2fa:${userId}`, TWOFA_ATTEMPT_LIMIT, TWOFA_ATTEMPT_WINDOW_SECONDS);
  return result.allowed ? null : result.retryAfterSeconds;
}

export async function getTwoFactorStatus(db: Db, userId: string): Promise<{ enabled: boolean; pending: boolean }> {
  const [row] = await db.select({ confirmedAt: userTotp.confirmedAt }).from(userTotp).where(eq(userTotp.userId, userId));
  return { enabled: Boolean(row?.confirmedAt), pending: Boolean(row && !row.confirmedAt) };
}

export class TwoFactorAlreadyEnabledError extends Error {
  constructor() {
    super("Two-factor authentication is already enabled");
  }
}

/** Starts (or restarts) enrolment with a new secret; nothing counts until `confirmEnrolment` succeeds. */
export async function beginEnrolment(db: Db, user: { id: string; email: string }, issuer: string) {
  const secret = generateTotpSecret();
  const secretEncrypted = encryptSecret(secret);
  const [row] = await db
    .insert(userTotp)
    .values({ userId: user.id, secretEncrypted })
    .onConflictDoUpdate({
      target: userTotp.userId,
      set: { secretEncrypted, createdAt: new Date() },
      setWhere: isNull(userTotp.confirmedAt),
    })
    .returning({ id: userTotp.id });
  if (!row) throw new TwoFactorAlreadyEnabledError();
  return { secret, uri: otpauthUri({ secret, account: user.email, issuer }) };
}

/** Checks the first code from the app, switches 2FA on and returns the recovery codes to show once. */
export async function confirmEnrolment(db: Db, userId: string, code: string, now = Date.now()) {
  const wait = await attemptAllowed(userId);
  if (wait !== null) return { ok: false as const, reason: "rate_limited" as const, retryAfterSeconds: wait };
  const [row] = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
  if (!row || row.confirmedAt) return { ok: false as const, reason: "not_enabled" as const };
  if (verifyTotp(decryptSecret(row.secretEncrypted), code, now) === null) {
    return { ok: false as const, reason: "invalid" as const };
  }
  const [confirmed] = await db
    .update(userTotp)
    .set({ confirmedAt: new Date(now) })
    .where(and(eq(userTotp.userId, userId), isNull(userTotp.confirmedAt)))
    .returning({ id: userTotp.id });
  if (!confirmed) return { ok: false as const, reason: "not_enabled" as const };
  return { ok: true as const, recoveryCodes: await replaceRecoveryCodes(db, userId) };
}

/** Verifies a login code from the authenticator app. */
export async function verifyTotpCode(db: Db, userId: string, code: string, now = Date.now()): Promise<VerifyResult> {
  const wait = await attemptAllowed(userId);
  if (wait !== null) return { ok: false, reason: "rate_limited", retryAfterSeconds: wait };
  const [row] = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
  if (!row?.confirmedAt) return { ok: false, reason: "not_enabled" };
  return verifyTotp(decryptSecret(row.secretEncrypted), code, now) === null
    ? { ok: false, reason: "invalid" }
    : { ok: true };
}

/** Spends a recovery code. The single UPDATE means two concurrent tries cannot both succeed. */
export async function verifyRecoveryCode(db: Db, userId: string, code: string): Promise<VerifyResult> {
  const wait = await attemptAllowed(userId);
  if (wait !== null) return { ok: false, reason: "rate_limited", retryAfterSeconds: wait };
  if (!normalizeRecoveryCode(code)) return { ok: false, reason: "invalid" };
  const [used] = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, hashRecoveryCode(code)), isNull(recoveryCodes.usedAt)),
    )
    .returning({ id: recoveryCodes.id });
  return used ? { ok: true } : { ok: false, reason: "invalid" };
}

export async function remainingRecoveryCodes(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return rows.length;
}
