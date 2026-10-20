import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { publishContentChanged } from "@/lib/content-library";
import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import {
  eventNotFound,
  findInteraction,
  findOwnedEvent,
  interactionNotFound,
  pollConfig,
  type PollConfig,
} from "@/lib/polls";

import { isNewInteractionType, newInteractionConfig } from "@/lib/interaction-config";
import { PlanLimitError, planLimitResponse } from "@/lib/limits";
import { assertNotOverLimit } from "@/lib/over-limit";
import { wordcloudConfig, type WordcloudConfig } from "@/lib/wordclouds";

type Context = { params: Promise<{ id: string; interactionId: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireMember(request, "event.edit");
  if (!auth.ok) return auth.response;
  const { id, interactionId } = await params;
  const event = await findOwnedEvent(id, auth.workspaceId);
  if (!event) return eventNotFound(request);
  const source = await findInteraction(event.id, interactionId);
  if (!source) return interactionNotFound(request);
  try {
    await assertNotOverLimit(auth.workspaceId, { eventId: event.id, type: source.type });
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }

  const config = isNewInteractionType(source.type)
    ? newInteractionConfig(source.type, source.config)
    : source.type === "wordcloud"
      ? wordcloudConfig(source.config as Partial<WordcloudConfig>, source.title)
      : (() => {
          const poll = pollConfig(source.config as Partial<PollConfig>);
          return { ...poll, options: poll.options.map((o) => ({ ...o, id: randomUUID() })) };
        })();
  const [interaction] = await getDb()
    .insert(interactions)
    .values({
      eventId: event.id,
      createdBy: auth.user.id,
      type: source.type,
      title: source.title,
      position: sql`(select coalesce(max(position) + 1, 0) from interactions where event_id = ${event.id})`,
      config,
    })
    .returning();
  publishContentChanged(event.id);
  return Response.json({ interaction }, { status: 201 });
}
