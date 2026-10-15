import { asc, eq, sql } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { eventNotFound, findOwnedEvent, parsePollInput, pollConfig } from "@/lib/polls";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const event = await findOwnedEvent((await params).id, auth.user.id);
  if (!event) return eventNotFound();
  const list = await getDb()
    .select()
    .from(interactions)
    .where(eq(interactions.eventId, event.id))
    .orderBy(asc(interactions.position), asc(interactions.createdAt));
  return Response.json({ interactions: list });
}

export async function POST(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const event = await findOwnedEvent((await params).id, auth.user.id);
  if (!event) return eventNotFound();

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || (body as { type?: unknown }).type !== "poll") {
    return Response.json({ error: "Interaction type must be 'poll'" }, { status: 400 });
  }
  const parsed = parsePollInput(body, false);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const [interaction] = await getDb()
    .insert(interactions)
    .values({
      eventId: event.id,
      type: "poll",
      title: parsed.value.title!,
      position: sql`(select coalesce(max(position) + 1, 0) from interactions where event_id = ${event.id})`,
      config: pollConfig(parsed.value.config),
    })
    .returning();
  return Response.json({ interaction }, { status: 201 });
}
