import { eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { generateUniqueJoinCode, parseEventInput } from "@/lib/events";
import { apiMessage, serverT } from "@/lib/i18n/server";
import { PlanLimitError, assertCanCreateEvent, planLimitResponse } from "@/lib/limits";
import { getEntitlements } from "@/lib/plans";
import { findTemplate, insertTemplateItems, templateItemsOf } from "@/lib/templates";

const UNIQUE_VIOLATION = "23505";

async function isCodeFree(code: string) {
  const rows = await getDb().select({ id: events.id }).from(events).where(eq(events.joinCode, code));
  return rows.length === 0;
}

/**
 * Body: the event fields of `POST /api/events` plus `templateId`. The event gets the template's items as drafts;
 * items of a type the plan does not include are left out (as when duplicating an event) and counted in `skipped`.
 */
export async function POST(request: Request) {
  const auth = await requireMember(request, "event.create");
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const templateId = body && typeof body === "object" ? (body as { templateId?: unknown }).templateId : undefined;
  const template = typeof templateId === "string" ? await findTemplate(templateId, auth.workspaceId) : null;
  if (!template) return Response.json({ error: serverT(request, "api.templateNotFound") }, { status: 404 });

  const parsed = parseEventInput(body, false);
  if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });
  const { name, startsAt, endsAt, moderationMode } = parsed.value;

  try {
    await assertCanCreateEvent(auth.workspaceId);
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }
  const { limits } = await getEntitlements(auth.workspaceId);
  const all = await templateItemsOf(template.id);
  const items = all.filter((i) => limits.allowedTypes.includes(i.type));

  for (let attempt = 0; attempt < 3; attempt++) {
    const joinCode = await generateUniqueJoinCode(isCodeFree);
    try {
      const event = await getDb().transaction(async (tx) => {
        const [created] = await tx
          .insert(events)
          .values({ ownerId: auth.user.id, createdBy: auth.user.id, workspaceId: auth.workspaceId, name: name!, startsAt: startsAt!, endsAt: endsAt!, moderationMode, joinCode })
          .returning();
        await insertTemplateItems(tx, created.id, auth.user.id, items);
        return created;
      });
      return Response.json({ event, skipped: all.length - items.length }, { status: 201 });
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
    }
  }
  return Response.json({ error: serverT(request, "api.joinCodeFailed") }, { status: 500 });
}
