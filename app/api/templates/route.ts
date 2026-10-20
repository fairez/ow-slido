import { requireMember } from "@/lib/auth/require-admin";
import { apiMessage, serverT } from "@/lib/i18n/server";
import { PlanLimitError, planLimitResponse } from "@/lib/limits";
import { getEntitlements } from "@/lib/plans";
import { eventNotFound, findInteraction, findOwnedEvent, interactionNotFound } from "@/lib/polls";
import { TEMPLATE_NAME_MAX, listTemplates, parseTemplateName, saveTemplate } from "@/lib/templates";

/** Every member can list: editors pick from the list although only owners and admins manage it. */
export async function GET(request: Request) {
  const auth = await requireMember(request);
  if (!auth.ok) return auth.response;

  const list = await listTemplates(auth.workspaceId);
  const { limits } = await getEntitlements(auth.workspaceId);
  return Response.json({
    templates: list,
    usage: { used: list.length, limit: limits.templates },
  });
}

/** Body: `{eventId, interactionId?, name?}`. With `interactionId` one item is saved, otherwise the event's whole list. */
export async function POST(request: Request) {
  const auth = await requireMember(request, "templates.manage");
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => null)) as { eventId?: unknown; interactionId?: unknown; name?: unknown } | null;
  if (!body || typeof body !== "object" || typeof body.eventId !== "string") {
    return Response.json({ error: serverT(request, "api.templateSourceInvalid") }, { status: 400 });
  }
  const event = await findOwnedEvent(body.eventId, auth.workspaceId);
  if (!event) return eventNotFound(request);
  let interactionId: string | undefined;
  let fallbackName = event.name.slice(0, TEMPLATE_NAME_MAX);
  if (body.interactionId !== undefined) {
    const source = typeof body.interactionId === "string" ? await findInteraction(event.id, body.interactionId) : null;
    if (!source) return interactionNotFound(request);
    interactionId = source.id;
    fallbackName = source.title.slice(0, TEMPLATE_NAME_MAX);
  }
  const parsed = parseTemplateName(body.name === undefined ? fallbackName : body.name);
  if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });

  try {
    const template = await saveTemplate({
      workspaceId: auth.workspaceId,
      userId: auth.user.id,
      name: parsed.name,
      kind: interactionId ? "interaction" : "event",
      eventId: event.id,
      interactionId,
    });
    if (!template) return Response.json({ error: serverT(request, "api.templateEmpty") }, { status: 400 });
    return Response.json({ template }, { status: 201 });
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }
}
