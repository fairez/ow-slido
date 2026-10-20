import { asc, eq } from "drizzle-orm";
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

/** The user's oldest workspace; US-006 replaces this with the active workspace from the session. */
export async function firstWorkspaceId(db: Executor, userId: string) {
  const [row] = await db
    .select({ id: memberships.workspaceId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt))
    .limit(1);
  return row?.id ?? null;
}
