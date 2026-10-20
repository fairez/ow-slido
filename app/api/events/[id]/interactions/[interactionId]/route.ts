import { serverT, apiMessage } from "@/lib/i18n/server";
import { and, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { publishContentChanged } from "@/lib/content-library";
import { denyUnlessCan, requireMember } from "@/lib/auth/require-admin";
import type { Action } from "@/lib/auth/permissions";
import { getDb } from "@/lib/db";
import { PlanLimitError, planLimitResponse } from "@/lib/limits";
import { assertNotOverLimit } from "@/lib/over-limit";
import { isNewInteractionType, newInteractionConfig, parseNewInteractionInput } from "@/lib/interaction-config";
import {
  eventNotFound,
  findInteraction,
  findOwnedEvent,
  interactionNotFound,
  parsePollInput,
  pollConfig,
  type PollConfig,
} from "@/lib/polls";
import { parseWordcloudInput, wordcloudConfig, type WordcloudConfig } from "@/lib/wordclouds";

type Context = { params: Promise<{ id: string; interactionId: string }> };

const notDraft = (request: Request) =>
  Response.json({ error: serverT(request, "api.draftOnly") }, { status: 409 });

async function load(request: Request, { params }: Context, action?: Action) {
  const auth = await requireMember(request, action);
  if (!auth.ok) return { response: auth.response };
  const { id, interactionId } = await params;
  const event = await findOwnedEvent(id, auth.workspaceId);
  if (!event) return { response: eventNotFound(request) };
  const interaction = await findInteraction(event.id, interactionId);
  if (!interaction) return { response: interactionNotFound(request) };
  return { interaction, auth };
}

export async function GET(request: Request, context: Context) {
  const loaded = await load(request, context);
  return loaded.response ?? Response.json({ interaction: loaded.interaction });
}

export async function PATCH(request: Request, context: Context) {
  const loaded = await load(request, context, "event.edit");
  if (!loaded.interaction) return loaded.response;
  const current = loaded.interaction;
  // A started Q&A keeps its name and prompt, but the host can still switch moderation while it runs.
  const qaSettingsOnly = current.type === "qa" && current.state !== "draft";
  if (current.state !== "draft" && !qaSettingsOnly) return notDraft(request);
  try {
    await assertNotOverLimit(loaded.auth.workspaceId, { eventId: current.eventId, type: current.type });
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }

  let title: string | undefined;
  let config: Record<string, unknown>;
  if (isNewInteractionType(current.type)) {
    const body = await request.json().catch(() => null);
    if (qaSettingsOnly && body && typeof body === "object" && ("title" in body || "prompt" in body)) return notDraft(request);
    const parsed = parseNewInteractionInput(current.type, body, true);
    if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });
    title = parsed.value.title;
    config = newInteractionConfig(current.type, { ...current.config, ...parsed.value.config });
  } else if (current.type === "wordcloud") {
    const parsed = parseWordcloudInput(await request.json().catch(() => null), true);
    if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });
    title = parsed.value.title;
    config = wordcloudConfig({ ...(current.config as Partial<WordcloudConfig>), ...parsed.value.config }, current.title);
  } else {
    const parsed = parsePollInput(await request.json().catch(() => null), true);
    if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });
    title = parsed.value.title;
    config = pollConfig({ ...(current.config as Partial<PollConfig>), ...parsed.value.config });
  }

  const [interaction] = await getDb()
    .update(interactions)
    .set({ ...(title !== undefined && { title }), config })
    .where(and(eq(interactions.id, current.id), eq(interactions.state, current.state)))
    .returning();
  if (!interaction) return notDraft(request);
  publishContentChanged(current.eventId);
  return Response.json({ interaction });
}

export async function DELETE(request: Request, context: Context) {
  const loaded = await load(request, context);
  if (!loaded.interaction) return loaded.response;
  const denied = denyUnlessCan(request, loaded.auth.role, "event.delete", {
    ownsContent: loaded.interaction.createdBy === loaded.auth.user.id,
  });
  if (denied) return denied;
  const deleted = await getDb()
    .delete(interactions)
    .where(and(eq(interactions.id, loaded.interaction.id), eq(interactions.state, "draft")))
    .returning({ id: interactions.id });
  if (!deleted.length) return notDraft(request);
  publishContentChanged(loaded.interaction.eventId);
  return new Response(null, { status: 204 });
}
