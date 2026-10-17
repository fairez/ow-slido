import { JOIN_TIMEOUT, NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";
export type JoinResult = { ok: true; eventId: string } | { ok: false; error: string };

export const JOIN_TIMEOUT_MS = 15_000;

/** Where to go after joining. The `j` flag lets the participant page tell "just joined but the cookie did not stick" from a first visit. */
export const participantPath = (eventId: string) => `/e/${eventId}?j=1`;

export async function joinEvent(code: string): Promise<JoinResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOIN_TIMEOUT_MS);
  try {
    const response = await fetch("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.event?.id) return { ok: true, eventId: body.event.id };
    return { ok: false, error: body?.error ?? SERVER_ERROR };
  } catch {
    return { ok: false, error: controller.signal.aborted ? JOIN_TIMEOUT : NETWORK_ERROR };
  } finally {
    clearTimeout(timer);
  }
}
