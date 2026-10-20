import { inArray } from "drizzle-orm";
import { memberships, workspaces } from "@/db/schema";
import type { createDb } from "@/db/client";

/** Name a personal workspace after the part of the email before the @. */
export const personalWorkspaceName = (email: string) => email.split("@")[0] || email;

type Executor = Pick<ReturnType<typeof createDb>["db"], "insert" | "select">;

export async function createPersonalWorkspace(db: Executor, user: { id: string; email: string }) {
  const [workspace] = await db.insert(workspaces).values({ name: personalWorkspaceName(user.email) }).returning();
  await db.insert(memberships).values({ workspaceId: workspace.id, userId: user.id, role: "owner" });
  return workspace;
}

/** Names for a user's active memberships, in membership order. */
export async function listActiveWorkspaces(
  db: Executor,
  rows: { workspaceId: string; role: string; status: string }[],
) {
  const active = rows.filter((m) => m.status === "active");
  if (active.length === 0) return [];
  const named = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(inArray(workspaces.id, active.map((m) => m.workspaceId)));
  const names = new Map(named.map((w) => [w.id, w.name]));
  return active.map((m) => ({ id: m.workspaceId, name: names.get(m.workspaceId) ?? "", role: m.role }));
}
