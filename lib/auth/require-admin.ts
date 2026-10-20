import { serverT } from "@/lib/i18n/server";
import { and, eq } from "drizzle-orm";
import { memberships, users } from "@/db/schema";
import { getDb } from "@/lib/db";
import { can, type Action } from "./permissions";
import { parseSessionToken, readSessionToken } from "./session";
import { WORKSPACE_COOKIE, readCookie, resolveActiveMembership, type MembershipInfo } from "./workspace";

export type AuthUser = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  mustChangePassword: boolean;
  memberships: MembershipInfo[];
};

export async function getUserFromToken(token: string | null | undefined): Promise<AuthUser | null> {
  const claims = token ? parseSessionToken(token) : null;
  if (!claims) return null;
  const db = getDb();
  const [found] = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      mustChangePassword: users.mustChangePassword,
      sessionsValidAfter: users.sessionsValidAfter,
    })
    .from(users)
    .where(and(eq(users.id, claims.userId), eq(users.active, true)));
  if (!found) return null;
  const { sessionsValidAfter, ...user } = found;
  if (sessionsValidAfter && claims.issuedAt < sessionsValidAfter.getTime()) return null;
  const rows = await db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  return { ...user, memberships: rows };
}

export function getSessionUser(request: Request) {
  return getUserFromToken(readSessionToken(request));
}

export async function requireAdmin(
  request: Request,
): Promise<{ ok: true; user: AuthUser } | { ok: false; response: Response }> {
  const user = await getSessionUser(request);
  if (!user) {
    return { ok: false, response: Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 }) };
  }
  const blocked = denyIfPasswordChangeRequired(request, user);
  if (blocked) return { ok: false, response: blocked };
  return { ok: true, user };
}

export type MemberContext = { user: AuthUser; workspaceId: string; role: MembershipInfo["role"] };

/** The signed-in user together with the workspace the request acts in; null for anonymous, non-member or suspended users. */
export async function getSessionMember(request: Request, workspaceId?: string): Promise<MemberContext | null> {
  const user = await getSessionUser(request);
  if (!user || user.mustChangePassword) return null;
  const membership = resolveActiveMembership(user.memberships, workspaceId ?? readCookie(request, WORKSPACE_COOKIE));
  if (!membership || (workspaceId && membership.workspaceId !== workspaceId)) return null;
  return { user, workspaceId: membership.workspaceId, role: membership.role };
}

/**
 * Resolves the active workspace (cookie `workspace`, default: first active membership). An explicit
 * `workspaceId` must be one the user is an active member of; otherwise the request is rejected.
 */
export async function requireMember(
  request: Request,
  action?: Action,
  workspaceId?: string,
): Promise<({ ok: true } & MemberContext) | { ok: false; response: Response }> {
  const user = await getSessionUser(request);
  if (!user) {
    return { ok: false, response: Response.json({ error: serverT(request, "api.unauthorized") }, { status: 401 }) };
  }
  const blocked = denyIfPasswordChangeRequired(request, user);
  if (blocked) return { ok: false, response: blocked };
  const membership = resolveActiveMembership(user.memberships, workspaceId ?? readCookie(request, WORKSPACE_COOKIE));
  if (!membership || (workspaceId && membership.workspaceId !== workspaceId)) {
    return { ok: false, response: Response.json({ error: serverT(request, "api.forbidden") }, { status: 403 }) };
  }
  if (action && !can(membership.role, action)) return { ok: false, response: forbidden(request) };
  return { ok: true, user, workspaceId: membership.workspaceId, role: membership.role };
}

/**
 * 403 with reason `password_change_required` while the account carries a temporary password. Only the
 * change-password page and API, `/api/auth/me` and logout skip this check; every other route goes through it.
 */
export function denyIfPasswordChangeRequired(request: Request, user: AuthUser): Response | null {
  if (!user.mustChangePassword) return null;
  return Response.json(
    { error: serverT(request, "api.passwordChangeRequired"), reason: "password_change_required" },
    { status: 403 },
  );
}

/** 403 with reason `email_unverified` for actions that need a confirmed email; null when the user may go on. */
export function denyUnlessVerified(request: Request, user: AuthUser): Response | null {
  if (user.emailVerifiedAt) return null;
  return Response.json(
    { error: serverT(request, "api.emailUnverified"), reason: "email_unverified" },
    { status: 403 },
  );
}

export function forbidden(request: Request): Response {
  return Response.json({ error: serverT(request, "api.forbidden") }, { status: 403 });
}

/** For actions that depend on who created the content (editors may only delete their own). */
export function denyUnlessCan(
  request: Request,
  role: MembershipInfo["role"],
  action: Action,
  opts: { ownsContent?: boolean },
): Response | null {
  return can(role, action, opts) ? null : forbidden(request);
}
