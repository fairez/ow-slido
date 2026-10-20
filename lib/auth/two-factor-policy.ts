import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { workspaces } from "@/db/schema";
import { getTwoFactorStatus } from "@/lib/auth/two-factor";
import { getDb } from "@/lib/db";
import { getEntitlements } from "@/lib/plans";

type Db = ReturnType<typeof getDb>;

/**
 * True when the workspace requires 2FA and this member has not turned it on. The flag only counts while the
 * plan still has `enforced2fa`, so a downgrade lifts the requirement without anyone having to switch it off.
 */
export async function twoFactorSetupRequired(workspaceId: string, userId: string, db: Db = getDb()): Promise<boolean> {
  const [workspace] = await db.select({ required: workspaces.require2fa }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace?.required) return false;
  const { limits } = await getEntitlements(workspaceId, { db });
  if (!limits.enforced2fa) return false;
  return !(await getTwoFactorStatus(db, userId)).enabled;
}

export function twoFactorRequiredResponse(message: string): Response {
  return Response.json({ error: message, reason: "two_factor_required" }, { status: 403 });
}

/** For server pages: sends a member the workspace holds back to the security page. Call after the membership is known. */
export async function redirectIfTwoFactorMissing(workspaceId: string, userId: string): Promise<void> {
  if (await twoFactorSetupRequired(workspaceId, userId)) redirect("/account/security");
}
