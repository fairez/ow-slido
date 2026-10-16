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
  const payload = `${userId}.${Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns the user id if the token is authentic and unexpired. */
export function verifySessionToken(token: string, now = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, signature] = parts;
  const expected = Buffer.from(sign(`${userId}.${expires}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (Number(expires) * 1000 < now) return null;
  return userId;
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
