import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { events, workspaces } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { serverT } from "@/lib/i18n/server";

type Db = Pick<ReturnType<typeof getDb>, "select">;

export const SUSPENDED_PATH = "/account/suspended";

/** True while the platform operator has suspended the workspace. */
export async function workspaceSuspended(workspaceId: string, db: Db = getDb()): Promise<boolean> {
  const [row] = await db.select({ at: workspaces.suspendedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return Boolean(row?.at);
}

/** True when the event belongs to a suspended workspace. An unknown event is not "unavailable", it is just unknown. */
export async function eventUnavailable(eventId: string, db: Db = getDb()): Promise<boolean> {
  if (!isUuid(eventId)) return false;
  const [row] = await db
    .select({ at: workspaces.suspendedAt })
    .from(events)
    .innerJoin(workspaces, eq(workspaces.id, events.workspaceId))
    .where(eq(events.id, eventId));
  return Boolean(row?.at);
}

export function workspaceSuspendedResponse(request: Request): Response {
  return Response.json({ error: serverT(request, "api.workspaceSuspended"), reason: "workspace_suspended" }, { status: 403 });
}

/**
 * For audience routes: the answer to give when the event's workspace is suspended, else null. The wording is
 * neutral on purpose; participants are not told why, only that the event cannot be reached.
 */
export async function eventUnavailableResponse(request: Request, eventId: string): Promise<Response | null> {
  if (!(await eventUnavailable(eventId))) return null;
  return Response.json({ error: serverT(request, "api.eventUnavailable"), reason: "event_unavailable" }, { status: 403 });
}

/** For server pages of a member: sends them to the notice page while their workspace is suspended. */
export async function redirectIfSuspended(workspaceId: string): Promise<void> {
  if (await workspaceSuspended(workspaceId)) redirect(SUSPENDED_PATH);
}
