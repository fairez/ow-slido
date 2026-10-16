// Small built-in blocklist; swap for a fuller list or service later.
const BLOCKED = new Set([
  "fuck",
  "fucking",
  "shit",
  "bitch",
  "bastard",
  "asshole",
  "dick",
  "cunt",
  "slut",
  "whore",
  "nigger",
  "faggot",
]);

/** True if the text, or any word in it, is on the blocklist. */
export function isProfane(text: string): boolean {
  const lower = text.toLowerCase();
  if (BLOCKED.has(lower.replace(/[^a-z]/g, ""))) return true;
  return lower.split(/[^a-z]+/).some((part) => BLOCKED.has(part));
}
