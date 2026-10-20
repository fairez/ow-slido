import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { interactions, templateItems, templates } from "@/db/schema";
import { getDb } from "@/lib/db";
import type { MessageKey } from "@/lib/i18n/en";
import { copyConfig } from "@/lib/interaction-copy";
import { isUuid } from "@/lib/events";
import { assertTemplateSlot } from "@/lib/limits";
import { getEntitlements } from "@/lib/plans";
import { TEMPLATE_NAME_MAX } from "@/lib/template-limits";

export { TEMPLATE_NAME_MAX };

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export type TemplateRow = typeof templates.$inferSelect;
export type TemplateItemRow = typeof templateItems.$inferSelect;

export function parseTemplateName(value: unknown): { ok: true; name: string } | { ok: false; error: MessageKey; params?: { max: number } } {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { ok: false, error: "api.templateNameRequired" };
  if (name.length > TEMPLATE_NAME_MAX) return { ok: false, error: "api.templateNameMax", params: { max: TEMPLATE_NAME_MAX } };
  return { ok: true, name };
}

export async function findTemplate(id: string, workspaceId: string): Promise<TemplateRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select()
    .from(templates)
    .where(and(eq(templates.id, id), eq(templates.workspaceId, workspaceId)));
  return row ?? null;
}

export async function templateItemsOf(templateId: string, db: Executor = getDb()): Promise<TemplateItemRow[]> {
  return db.select().from(templateItems).where(eq(templateItems.templateId, templateId)).orderBy(asc(templateItems.position));
}

/**
 * Saves interactions of an event as a template. Only type, title and config are stored (config through
 * `copyConfig`); state, position in the event, responses, participants, questions and notes stay behind.
 * Returns null when the event has nothing to save. Throws `PlanLimitError` at the template limit.
 */
export async function saveTemplate(input: {
  workspaceId: string;
  userId: string;
  name: string;
  kind: "interaction" | "event";
  eventId: string;
  interactionId?: string;
}): Promise<TemplateRow | null> {
  const where = input.interactionId
    ? and(eq(interactions.eventId, input.eventId), eq(interactions.id, input.interactionId))
    : eq(interactions.eventId, input.eventId);
  return getDb().transaction(async (tx) => {
    // The workspace row is the lock that keeps two saves from both taking the last slot.
    await tx.execute(sql`select 1 from workspaces where id = ${input.workspaceId} for update`);
    await assertTemplateSlot(input.workspaceId, tx);
    const source = await tx.select().from(interactions).where(where).orderBy(asc(interactions.position), asc(interactions.createdAt));
    if (source.length === 0) return null;
    const [template] = await tx
      .insert(templates)
      .values({ workspaceId: input.workspaceId, name: input.name, kind: input.kind, createdBy: input.userId })
      .returning();
    await tx.insert(templateItems).values(
      source.map((i, index) => ({
        templateId: template.id,
        position: index,
        type: i.type,
        title: i.title,
        config: copyConfig(i.type, i.title, i.config),
      })),
    );
    return template;
  });
}

/** Template items that the workspace's plan does not include; adding them to an event would be refused. */
export async function lockedTemplateTypes(workspaceId: string, items: Pick<TemplateItemRow, "type">[]) {
  const { limits } = await getEntitlements(workspaceId);
  return [...new Set(items.map((i) => i.type))].filter((type) => !limits.allowedTypes.includes(type));
}

/** Inserts copies of template items as drafts, after the event's existing content. Poll option ids are new. */
export async function insertTemplateItems(tx: Executor, eventId: string, userId: string, items: TemplateItemRow[]) {
  if (items.length === 0) return [];
  const [{ next }] = (await tx.execute<{ next: number }>(
    sql`select coalesce(max(position) + 1, 0)::int as next from interactions where event_id = ${eventId}`,
  )).rows;
  return tx
    .insert(interactions)
    .values(
      items.map((item, index) => ({
        eventId,
        createdBy: userId,
        type: item.type,
        title: item.title,
        state: "draft" as const,
        position: next + index,
        config: copyConfig(item.type, item.title, item.config),
      })),
    )
    .returning();
}

export type TemplateWithItems = TemplateRow & { items: { type: TemplateItemRow["type"]; title: string }[] };

/** The workspace's templates, newest first, each with the type and title of its items in order. */
export async function listTemplates(workspaceId: string): Promise<TemplateWithItems[]> {
  const db = getDb();
  const rows = await db.select().from(templates).where(eq(templates.workspaceId, workspaceId)).orderBy(desc(templates.createdAt), desc(templates.id));
  if (rows.length === 0) return [];
  const items = await db
    .select({ templateId: templateItems.templateId, type: templateItems.type, title: templateItems.title })
    .from(templateItems)
    .where(inArray(templateItems.templateId, rows.map((row) => row.id)))
    .orderBy(asc(templateItems.position));
  const byTemplate = new Map<string, TemplateWithItems["items"]>();
  for (const item of items) byTemplate.set(item.templateId, [...(byTemplate.get(item.templateId) ?? []), { type: item.type, title: item.title }]);
  return rows.map((row) => ({ ...row, items: byTemplate.get(row.id) ?? [] }));
}
