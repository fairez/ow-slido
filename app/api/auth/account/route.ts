import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { denyIfPasswordChangeRequired, getSessionUser } from "@/lib/auth/require-admin";
import { isSecureRequest, sessionClearCookie } from "@/lib/auth/session";
import { deleteAccount } from "@/lib/account-deletion";
import { auditContext, recordAudit } from "@/lib/audit";
import { billingErrorResponse } from "@/lib/billing/http";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";
import { rateLimit } from "@/lib/rate-limit";

const DELETE_LIMIT = 10;
const DELETE_WINDOW_SECONDS = 15 * 60;

/**
 * Deletes the signed-in account after a password check. The person's memberships end and what they created stays
 * with the workspace; a workspace they alone belong to is deleted with them. 409 `sole_owner` (with the workspaces)
 * when they are the last owner of a workspace with other members.
 */
export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 });
  const blocked = denyIfPasswordChangeRequired(request, user);
  if (blocked) return blocked;

  const limit = await rateLimit(`account-delete:user:${user.id}`, DELETE_LIMIT, DELETE_WINDOW_SECONDS);
  if (!limit.allowed) {
    return Response.json(
      { error: serverT(request, "api.tooManyAttempts") },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";
  const db = getDb();
  const [row] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id));
  if (!row || !password || !(await verifyPassword(password, row.hash))) {
    return Response.json({ error: serverT(request, "api.currentPasswordWrong") }, { status: 400 });
  }

  let result;
  try {
    result = await deleteAccount(db, user.id);
  } catch (error) {
    const response = billingErrorResponse(request, error);
    if (response) return response;
    throw error;
  }
  if (!result.ok) {
    return Response.json(
      { error: serverT(request, result.error), reason: result.reason, workspaces: result.workspaces },
      { status: result.status },
    );
  }

  // The person is gone, so the entries go to the workspaces that remain; the email stays in the label like any other entry.
  for (const workspaceId of result.leftWorkspaceIds) {
    await recordAudit(undefined, {
      ...auditContext(request, user),
      workspaceId,
      action: "auth.account_deleted",
      targetType: "user",
      targetId: user.id,
    });
  }
  return Response.json({ ok: true }, { headers: { "set-cookie": sessionClearCookie(isSecureRequest(request)) } });
}
