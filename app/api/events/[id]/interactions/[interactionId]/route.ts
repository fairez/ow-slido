import { and, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/require-admin";
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

const notDraft = () =>
  Response.json({ error: "Only draft interactions can be changed" }, { status: 409 });

async function load(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return { response: auth.response };
  const { id, interactionId } = await params;
  const event = await findOwnedEvent(id, auth.user.id);
  if (!event) return { response: eventNotFound() };
  const interaction = await findInteraction(event.id, interactionId);
  if (!interaction) return { response: interactionNotFound() };
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
  if (current.state !== "draft") return notDraft();

  let title: string | undefined;
  let config: Record<string, unknown>;
  if (isNewInteractionType(current.type)) {
    const parsed = parseNewInteractionInput(current.type, await request.json().catch(() => null), true);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    title = parsed.value.title;
    config = newInteractionConfig(current.type, { ...current.config, ...parsed.value.config });
  } else if (current.type === "wordcloud") {
    const parsed = parseWordcloudInput(await request.json().catch(() => null), true);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    title = parsed.value.title;
    config = wordcloudConfig({ ...(current.config as Partial<WordcloudConfig>), ...parsed.value.config }, current.title);
  } else {
    const parsed = parsePollInput(await request.json().catch(() => null), true);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    title = parsed.value.title;
    config = pollConfig({ ...(current.config as Partial<PollConfig>), ...parsed.value.config });
  }

  const [interaction] = await getDb()
    .update(interactions)
    .set({ ...(title !== undefined && { title }), config })
    .where(and(eq(interactions.id, current.id), eq(interactions.state, "draft")))
    .returning();
  return interaction ? Response.json({ interaction }) : notDraft();
}

export async function DELETE(request: Request, context: Context) {
  const loaded = await load(request, context);
  if (!loaded.interaction) return loaded.response;
  const deleted = await getDb()
    .delete(interactions)
    .where(and(eq(interactions.id, loaded.interaction.id), eq(interactions.state, "draft")))
    .returning({ id: interactions.id });
  return deleted.length ? new Response(null, { status: 204 }) : notDraft();
}
