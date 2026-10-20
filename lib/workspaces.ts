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
