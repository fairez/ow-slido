import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not set");
  return value;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSessionToken(userId: string, now = Date.now()) {
  const payload = `${userId}.${now}.${Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS}`;
  return `${payload}.${sign(payload)}`;
}

export type SessionClaims = { userId: string; issuedAt: number };

/**
 * Returns who the token belongs to and when it was issued (ms) if it is authentic and unexpired.
 * Older tokens without an issued-at time derive it from the expiry.
 */
export function parseSessionToken(token: string, now = Date.now()): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const signature = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join(".");
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const expires = Number(parts[parts.length - 2]);
  if (expires * 1000 < now) return null;
  const issuedAt = parts.length === 4 ? Number(parts[1]) : (expires - SESSION_MAX_AGE_SECONDS) * 1000;
  if (!Number.isFinite(issuedAt)) return null;
  return { userId: parts[0], issuedAt };
}

/** Returns the user id if the token is authentic and unexpired. */
export function verifySessionToken(token: string, now = Date.now()): string | null {
  return parseSessionToken(token, now)?.userId ?? null;
}

/** True when the client reached us over HTTPS, directly or through a TLS-terminating proxy. */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  return new URL(request.url).protocol === "https:";
}

/** `Secure` cookies are dropped by browsers on plain http (except localhost), so only set it on https. */
export function cookieAttributes(maxAge: number, secure: boolean) {
  return `Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=${maxAge}`;
}

export function sessionSetCookie(userId: string, secure: boolean) {
  return `${SESSION_COOKIE}=${createSessionToken(userId)}; ${cookieAttributes(SESSION_MAX_AGE_SECONDS, secure)}`;
}

export function sessionClearCookie(secure: boolean) {
  return `${SESSION_COOKIE}=; ${cookieAttributes(0, secure)}`;
}

export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}
