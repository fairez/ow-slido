import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import {
  eventNotFound,
  findInteraction,
  findOwnedEvent,
  interactionNotFound,
  pollConfig,
  type PollConfig,
} from "@/lib/polls";

type Context = { params: Promise<{ id: string; interactionId: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id, interactionId } = await params;
  const event = await findOwnedEvent(id, auth.user.id);
  if (!event) return eventNotFound();
  const source = await findInteraction(event.id, interactionId);
  if (!source) return interactionNotFound();

  const config = pollConfig(source.config as Partial<PollConfig>);
  const [interaction] = await getDb()
    .insert(interactions)
    .values({
      eventId: event.id,
      type: source.type,
      title: source.title,
      position: sql`(select coalesce(max(position) + 1, 0) from interactions where event_id = ${event.id})`,
      config: { ...config, options: config.options.map((o) => ({ ...o, id: randomUUID() })) },
    })
    .returning();
  return Response.json({ interaction }, { status: 201 });
}
