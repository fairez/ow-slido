import { createHmac, timingSafeEqual } from "node:crypto";

export const PENDING_TWOFA_TTL_SECONDS = 5 * 60;

function sign(payload: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Handed out after the password was right but before the second factor. The `2fa-pending` prefix is part of
 * the signed text, so it can never parse as a session token (and the other way round).
 */
export function createPendingTwoFactorToken(userId: string, now = Date.now()) {
  const payload = `2fa-pending.${userId}.${Math.floor(now / 1000) + PENDING_TWOFA_TTL_SECONDS}`;
  return `${payload}.${sign(payload)}`;
}

/** The user id if the token is authentic and unexpired. */
export function parsePendingTwoFactorToken(token: string, now = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "2fa-pending") return null;
  const payload = parts.slice(0, 3).join(".");
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(parts[3]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (Number(parts[2]) * 1000 < now) return null;
  return parts[1];
}
