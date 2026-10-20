import { serverT, apiMessage } from "@/lib/i18n/server";
import { and, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
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

async function load(request: Request, { params }: Context) {
  const auth = await requireMember(request);
  if (!auth.ok) return { response: auth.response };
  const { id, interactionId } = await params;
  const event = await findOwnedEvent(id, auth.workspaceId);
  if (!event) return { response: eventNotFound(request) };
  const interaction = await findInteraction(event.id, interactionId);
  if (!interaction) return { response: interactionNotFound(request) };
  return { interaction };
}

export async function GET(request: Request, context: Context) {
  const loaded = await load(request, context);
  return loaded.response ?? Response.json({ interaction: loaded.interaction });
}

export async function PATCH(request: Request, context: Context) {
  const loaded = await load(request, context);
  if (!loaded.interaction) return loaded.response;
  const current = loaded.interaction;
  if (current.state !== "draft") return notDraft(request);

  let title: string | undefined;
  let config: Record<string, unknown>;
  if (isNewInteractionType(current.type)) {
    const parsed = parseNewInteractionInput(current.type, await request.json().catch(() => null), true);
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
    .where(and(eq(interactions.id, current.id), eq(interactions.state, "draft")))
    .returning();
  return interaction ? Response.json({ interaction }) : notDraft(request);
}

export async function DELETE(request: Request, context: Context) {
  const loaded = await load(request, context);
  if (!loaded.interaction) return loaded.response;
  const deleted = await getDb()
    .delete(interactions)
    .where(and(eq(interactions.id, loaded.interaction.id), eq(interactions.state, "draft")))
    .returning({ id: interactions.id });
  return deleted.length ? new Response(null, { status: 204 }) : notDraft(request);
}
