import { createHmac, timingSafeEqual } from "node:crypto";

export const PARTICIPANT_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** One cookie per event, so joining a second event doesn't evict the first. */
export const participantCookieName = (eventId: string) => `participant_${eventId}`;

function sign(payload: string) {
  const secret = process.env.PARTICIPANT_TOKEN_SECRET;
  if (!secret) throw new Error("PARTICIPANT_TOKEN_SECRET is not set");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createParticipantToken(eventId: string, participantId: string) {
  const payload = `${eventId}.${participantId}`;
  return `${participantId}.${sign(payload)}`;
}

/** Returns the participant id if the token is authentic for this event. */
export function verifyParticipantToken(token: string, eventId: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [participantId, signature] = parts;
  const expected = Buffer.from(sign(`${eventId}.${participantId}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return participantId;
}

export function participantSetCookie(eventId: string, participantId: string) {
  const value = createParticipantToken(eventId, participantId);
  return `${participantCookieName(eventId)}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${PARTICIPANT_MAX_AGE_SECONDS}`;
}

export function readParticipantToken(request: Request, eventId: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const wanted = participantCookieName(eventId);
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === wanted) return rest.join("=");
  }
  return null;
}
