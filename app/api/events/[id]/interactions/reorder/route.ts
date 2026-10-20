import { serverT } from "@/lib/i18n/server";
import { and, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { eventNotFound, findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string }> };

/** Body `{ ids }` lists every interaction of the event in the desired order. */
export async function POST(request: Request, { params }: Context) {
  const auth = await requireMember(request);
  if (!auth.ok) return auth.response;
  const event = await findOwnedEvent((await params).id, auth.workspaceId);
  if (!event) return eventNotFound(request);

  const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return Response.json({ error: serverT(request, "api.idsList") }, { status: 400 });
  }

  const db = getDb();
  const ok = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: interactions.id })
      .from(interactions)
      .where(eq(interactions.eventId, event.id));
    const known = new Set(existing.map((r) => r.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
      return false;
    }
    for (const [position, id] of (ids as string[]).entries()) {
      await tx
        .update(interactions)
        .set({ position })
        .where(and(eq(interactions.id, id), eq(interactions.eventId, event.id)));
    }
    return true;
  });
  if (!ok) {
    return Response.json({ error: serverT(request, "api.idsEvery") }, { status: 400 });
  }
  return Response.json({ ok: true });
}
