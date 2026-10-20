import { serverT, apiMessage } from "@/lib/i18n/server";
import { asc, eq, sql } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { isNewInteractionType, newInteractionConfig, parseNewInteractionInput } from "@/lib/interaction-config";
import { eventNotFound, findOwnedEvent, parsePollInput, pollConfig } from "@/lib/polls";
import { parseWordcloudInput, wordcloudConfig } from "@/lib/wordclouds";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await requireMember(request);
  if (!auth.ok) return auth.response;
  const event = await findOwnedEvent((await params).id, auth.workspaceId);
  if (!event) return eventNotFound(request);
  const list = await getDb()
    .select()
    .from(interactions)
    .where(eq(interactions.eventId, event.id))
    .orderBy(asc(interactions.position), asc(interactions.createdAt));
  return Response.json({ interactions: list });
}

export async function POST(request: Request, { params }: Context) {
  const auth = await requireMember(request);
  if (!auth.ok) return auth.response;
  const event = await findOwnedEvent((await params).id, auth.workspaceId);
  if (!event) return eventNotFound(request);

  const body = await request.json().catch(() => null);
  const type = body && typeof body === "object" ? (body as { type?: unknown }).type : undefined;
  if (type !== "poll" && type !== "wordcloud" && !isNewInteractionType(type)) {
    return Response.json(
      { error: serverT(request, "api.typeInvalid") },
      { status: 400 },
    );
  }
  let title: string;
  let config: Record<string, unknown>;
  if (type === "poll") {
    const parsed = parsePollInput(body, false);
    if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });
    title = parsed.value.title!;
    config = pollConfig(parsed.value.config);
  } else if (isNewInteractionType(type)) {
    const parsed = parseNewInteractionInput(type, body, false);
    if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });
    title = parsed.value.title!;
    config = newInteractionConfig(type, parsed.value.config);
  } else {
    const parsed = parseWordcloudInput(body, false);
    if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });
    title = parsed.value.title!;
    config = wordcloudConfig(parsed.value.config);
  }

  const [interaction] = await getDb()
    .insert(interactions)
    .values({
      eventId: event.id,
      type,
      title,
      position: sql`(select coalesce(max(position) + 1, 0) from interactions where event_id = ${event.id})`,
      config,
    })
    .returning();
  return Response.json({ interaction }, { status: 201 });
}
