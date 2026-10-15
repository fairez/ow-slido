import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";

export const MODERATOR_HEADER = "x-moderator-token";

function sign(payload: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(`moderator.${payload}`).digest("base64url");
}

/** Token format `<nonce>.<signature>`; the signature binds the nonce to one event. */
export function createModeratorToken(eventId: string, nonce: string) {
  return `${nonce}.${sign(`${eventId}.${nonce}`)}`;
}

/**
 * True only if the token is authentic for this event AND its nonce is still the event's current one,
 * so revoking or regenerating the link invalidates old tokens immediately.
 */
export async function verifyModeratorToken(eventId: string, token: string | null | undefined): Promise<boolean> {
  if (!token || !isUuid(eventId)) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [nonce, signature] = parts;
  const expected = Buffer.from(sign(`${eventId}.${nonce}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  const [event] = await getDb()
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.moderatorNonce, nonce)));
  return Boolean(event);
}

/** Replaces any existing moderator link with a fresh one and returns its token. */
export async function regenerateModeratorToken(eventId: string) {
  const nonce = randomBytes(16).toString("base64url");
  await getDb().update(events).set({ moderatorNonce: nonce }).where(eq(events.id, eventId));
  return createModeratorToken(eventId, nonce);
}

export async function revokeModeratorToken(eventId: string) {
  await getDb().update(events).set({ moderatorNonce: null }).where(eq(events.id, eventId));
}
