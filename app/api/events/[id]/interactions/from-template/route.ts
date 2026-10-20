import { publishContentChanged } from "@/lib/content-library";
import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";
import { PlanLimitError, assertTypeAllowed, planLimitResponse } from "@/lib/limits";
import { assertNotOverLimit } from "@/lib/over-limit";
import { eventNotFound, findOwnedEvent } from "@/lib/polls";
import { findTemplate, insertTemplateItems, templateItemsOf } from "@/lib/templates";

type Context = { params: Promise<{ id: string }> };

/** Body: `{templateId}`. Adds the template's items to the event as drafts; all of them or, on a plan error, none. */
export async function POST(request: Request, { params }: Context) {
  const auth = await requireMember(request, "event.edit");
  if (!auth.ok) return auth.response;
  const event = await findOwnedEvent((await params).id, auth.workspaceId);
  if (!event) return eventNotFound(request);

  const body = (await request.json().catch(() => null)) as { templateId?: unknown } | null;
  const template = typeof body?.templateId === "string" ? await findTemplate(body.templateId, auth.workspaceId) : null;
  if (!template) return Response.json({ error: serverT(request, "api.templateNotFound") }, { status: 404 });

  const items = await templateItemsOf(template.id);
  try {
    await assertNotOverLimit(auth.workspaceId, { eventId: event.id });
    for (const type of new Set(items.map((i) => i.type))) await assertTypeAllowed(auth.workspaceId, type);
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }
  const created = await getDb().transaction((tx) => insertTemplateItems(tx, event.id, auth.user.id, items));
  publishContentChanged(event.id);
  return Response.json({ interactions: created }, { status: 201 });
}
