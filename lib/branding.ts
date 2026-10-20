import { eq } from "drizzle-orm";
import { events, interactions, workspaces } from "@/db/schema";
import { getDb } from "@/lib/db";
import { getEntitlements } from "@/lib/plans";

type Db = ReturnType<typeof getDb>;

/**
 * The accent a workspace's audience and presenter screens use: the stored colour while the plan still has
 * branding, else null. A downgrade lifts the colour without clearing the column, so the check is made on every read.
 */
export async function workspaceAccent(workspaceId: string, db: Db = getDb()): Promise<string | null> {
  const [row] = await db.select({ accent: workspaces.brandAccent }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!row?.accent) return null;
  const { limits } = await getEntitlements(workspaceId, { db });
  return limits.branding ? row.accent : null;
}

export async function eventAccent(eventId: string, db: Db = getDb()): Promise<string | null> {
  const [row] = await db.select({ workspaceId: events.workspaceId }).from(events).where(eq(events.id, eventId));
  return row ? workspaceAccent(row.workspaceId, db) : null;
}

export async function eventAccentByJoinCode(joinCode: string, db: Db = getDb()): Promise<string | null> {
  if (!/^[0-9]{4,6}$/.test(joinCode)) return null;
  const [row] = await db.select({ workspaceId: events.workspaceId }).from(events).where(eq(events.joinCode, joinCode));
  return row ? workspaceAccent(row.workspaceId, db) : null;
}

export async function interactionAccent(interactionId: string, db: Db = getDb()): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: events.workspaceId })
    .from(interactions)
    .innerJoin(events, eq(events.id, interactions.eventId))
    .where(eq(interactions.id, interactionId));
  return row ? workspaceAccent(row.workspaceId, db) : null;
}
