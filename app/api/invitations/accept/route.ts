import { getSessionUser } from "@/lib/auth/require-admin";
import { isSecureRequest, sessionSetCookie } from "@/lib/auth/session";
import { workspaceSetCookie } from "@/lib/auth/workspace";
import { getDb } from "@/lib/db";
import { apiMessage, serverT } from "@/lib/i18n/server";
import { acceptInvitation } from "@/lib/invitations";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const ACCEPT_LIMIT = 10;
const ACCEPT_WINDOW_SECONDS = 15 * 60;

/**
 * Body `{ token, password? }`. Signed in: the account's email must match the invitation. Signed out: an
 * unknown email creates a verified account with `password`; a known one gets 401 `login_required`.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { token?: unknown; password?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token : "";
  const password = typeof body?.password === "string" ? body.password : null;

  const limit = await rateLimit(`invite-accept:ip:${clientIp(request)}`, ACCEPT_LIMIT, ACCEPT_WINDOW_SECONDS);
  if (!limit.allowed) {
    return Response.json(
      { error: serverT(request, "api.tooManyAttempts") },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }
  if (!token) return Response.json({ error: serverT(request, "api.inviteInvalid") }, { status: 400 });

  const user = await getSessionUser(request);
  const result = await acceptInvitation(getDb(), {
    token,
    sessionUser: user ? { id: user.id, email: user.email } : null,
    password,
  });
  if (!result.ok) {
    return Response.json(
      { error: apiMessage(request, result), ...(result.reason ? { reason: result.reason } : {}) },
      { status: result.status },
    );
  }

  const secure = isSecureRequest(request);
  const headers = new Headers();
  if (!user) headers.append("set-cookie", sessionSetCookie(result.userId, secure));
  headers.append("set-cookie", workspaceSetCookie(result.workspaceId, secure));
  return Response.json({ ok: true, workspaceId: result.workspaceId, role: result.role }, { headers });
}
