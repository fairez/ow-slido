import { serverT, apiMessage } from "@/lib/i18n/server";
import { and, eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { denyUnlessCan, requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { isUuid, parseEventInput } from "@/lib/events";
import { PlanLimitError, planLimitResponse } from "@/lib/limits";
import { assertNotOverLimit } from "@/lib/over-limit";

type Context = { params: Promise<{ id: string }> };

const notFound = (request: Request) => Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });

async function findOwned(id: string, workspaceId: string) {
  if (!isUuid(id)) return null;
  const [event] = await getDb()
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.workspaceId, workspaceId)));
  return event ?? null;
}

export async function GET(request: Request, { params }: Context) {
  const auth = await requireMember(request);
  if (!auth.ok) return auth.response;
  const event = await findOwned((await params).id, auth.workspaceId);
  return event ? Response.json({ event }) : notFound(request);
}

export async function PATCH(request: Request, { params }: Context) {
  const auth = await requireMember(request, "event.edit");
  if (!auth.ok) return auth.response;
  const current = await findOwned((await params).id, auth.workspaceId);
  if (!current) return notFound(request);
  try {
    await assertNotOverLimit(auth.workspaceId, { eventId: current.id });
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }

  const parsed = parseEventInput(await request.json().catch(() => null), true);
  if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });
  const changes = parsed.value;
  const startsAt = changes.startsAt ?? current.startsAt;
  const endsAt = changes.endsAt ?? current.endsAt;
  if (endsAt < startsAt) {
    return Response.json({ error: serverT(request, "api.endBeforeStart") }, { status: 400 });
  }

  // `moderationMode` is only the default for Q&As created later; each Q&A keeps its own mode.
  const [event] = await getDb().update(events).set(changes).where(eq(events.id, current.id)).returning();
  return Response.json({ event });
}

export async function DELETE(request: Request, { params }: Context) {
  const auth = await requireMember(request);
  if (!auth.ok) return auth.response;
  const current = await findOwned((await params).id, auth.workspaceId);
  if (!current) return notFound(request);
  const denied = denyUnlessCan(request, auth.role, "event.delete", { ownsContent: current.createdBy === auth.user.id });
  if (denied) return denied;
  await getDb().delete(events).where(eq(events.id, current.id));
  return new Response(null, { status: 204 });
}
