import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";
export type JoinResult = { ok: true; eventId: string } | { ok: false; error: string };

export async function joinEvent(code: string): Promise<JoinResult> {
  try {
    const response = await fetch("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.event?.id) return { ok: true, eventId: body.event.id };
    return { ok: false, error: body?.error ?? SERVER_ERROR };
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
}
