import { and, eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { isUuid, parseEventInput } from "@/lib/events";

type Context = { params: Promise<{ id: string }> };

const notFound = () => Response.json({ error: "Event not found" }, { status: 404 });

async function findOwned(id: string, ownerId: string) {
  if (!isUuid(id)) return null;
  const [event] = await getDb()
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.ownerId, ownerId)));
  return event ?? null;
}

export async function GET(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const event = await findOwned((await params).id, auth.user.id);
  return event ? Response.json({ event }) : notFound();
}

export async function PATCH(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const current = await findOwned((await params).id, auth.user.id);
  if (!current) return notFound();

  const parsed = parseEventInput(await request.json().catch(() => null), true);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const changes = parsed.value;
  const startsAt = changes.startsAt ?? current.startsAt;
  const endsAt = changes.endsAt ?? current.endsAt;
  if (endsAt < startsAt) {
    return Response.json({ error: "End date cannot be before the start date" }, { status: 400 });
  }

  const [event] = await getDb()
    .update(events)
    .set(changes)
    .where(eq(events.id, current.id))
    .returning();
  return Response.json({ event });
}

export async function DELETE(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const current = await findOwned((await params).id, auth.user.id);
  if (!current) return notFound();
  await getDb().delete(events).where(eq(events.id, current.id));
  return new Response(null, { status: 204 });
}
