import { and, desc, eq, lt } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { authTokens, invitations, memberships, users, workspaces } from "@/db/schema";
import { getEmailSender } from "@/lib/email";
import { MIN_PASSWORD_LENGTH, isValidEmail } from "@/lib/auth/credentials";
import { hashPassword } from "@/lib/auth/password";
import { hashToken, issueTokenRecord } from "@/lib/auth/tokens";
import type { MessageKey } from "@/lib/i18n/en";

type Db = ReturnType<typeof createDb>["db"];

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The owner role is never handed out by invitation. */
export const INVITABLE_ROLES = ["admin", "editor", "moderator", "viewer"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

const UNIQUE_VIOLATION = "23505";

export type InviteFailure = {
  ok: false;
  error: MessageKey;
  status: number;
  reason?: string;
  params?: Record<string, string | number>;
};
type Failure = InviteFailure;
const fail = (error: MessageKey, status: number, reason?: string, params?: Failure["params"]): Failure => ({
  ok: false,
  error,
  status,
  reason,
  params,
});

export function parseInviteInput(
  body: unknown,
): { ok: true; value: { email: string; role: InvitableRole } } | Failure {
  const raw = body as { email?: unknown; role?: unknown } | null;
  const email = typeof raw?.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) return fail("api.emailInvalid", 400);
  const role = INVITABLE_ROLES.find((r) => r === raw?.role);
  if (!role) return fail("api.inviteRoleInvalid", 400);
  return { ok: true, value: { email, role } };
}

/** Writes `expired` on pending invitations past their deadline, so the unique pending-email index frees up. */
async function expireStale(db: Db, workspaceId: string) {
  await db
    .update(invitations)
    .set({ status: "expired" })
    .where(
      and(eq(invitations.workspaceId, workspaceId), eq(invitations.status, "pending"), lt(invitations.expiresAt, new Date())),
    );
}

export async function listInvitations(db: Db, workspaceId: string) {
  await expireStale(db, workspaceId);
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      status: invitations.status,
      invitedBy: invitations.invitedBy,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(eq(invitations.workspaceId, workspaceId))
    .orderBy(desc(invitations.createdAt));
}

/** Returns the raw token once; only its hash is stored. */
export async function createInvitation(
  db: Db,
  input: { workspaceId: string; email: string; role: InvitableRole; invitedBy: string },
) {
  await expireStale(db, input.workspaceId);

  const [member] = await db
    .select({ userId: memberships.userId })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(and(eq(users.email, input.email), eq(memberships.workspaceId, input.workspaceId)));
  if (member) return fail("api.inviteAlreadyMember", 409);

  const issued = await issueTokenRecord(db, { userId: null, purpose: "invite", ttlMs: INVITE_TTL_MS });
  try {
    const [invitation] = await db
      .insert(invitations)
      .values({ ...input, tokenId: issued.id, expiresAt: issued.expiresAt })
      .returning({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      });
    return { ok: true as const, invitation, token: issued.token };
  } catch (error) {
    await db.delete(authTokens).where(eq(authTokens.id, issued.id));
    // Drizzle wraps the driver error; the Postgres code sits on `cause`.
    const code = (error as { code?: string; cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
    if (code === UNIQUE_VIOLATION) return fail("api.inviteDuplicate", 409);
    throw error;
  }
}

export async function revokeInvitation(db: Db, workspaceId: string, id: string) {
  const [found] = await db
    .select({ status: invitations.status, tokenId: invitations.tokenId })
    .from(invitations)
    .where(and(eq(invitations.id, id), eq(invitations.workspaceId, workspaceId)));
  if (!found) return fail("api.inviteNotFound", 404);
  const [revoked] = await db
    .update(invitations)
    .set({ status: "revoked" })
    .where(and(eq(invitations.id, id), eq(invitations.status, "pending")))
    .returning({ id: invitations.id });
  if (!revoked) return fail("api.inviteNotPending", 409);
  await db.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, found.tokenId));
  return { ok: true as const };
}

export async function sendInvitationEmail(
  db: Db,
  input: { workspaceId: string; email: string; role: InvitableRole; link: string },
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): Promise<boolean> {
  const [workspace] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId));
  try {
    await getEmailSender().send({
      to: input.email,
      subject: t("email.invite.subject", { workspace: workspace?.name ?? "" }),
      text: t("email.invite.body", {
        workspace: workspace?.name ?? "",
        role: t(`role.${input.role}` as MessageKey),
        link: input.link,
        days: INVITE_TTL_MS / (24 * 60 * 60 * 1000),
      }),
    });
    return true;
  } catch {
    return false;
  }
}

class Abort extends Error {
  constructor(readonly failure: Failure) {
    super(failure.error);
  }
}

/**
 * Joins the invited email to the workspace. A signed-in user must own the invited email; without a
 * session, an unknown email creates a verified account with `password`, a known one must log in first.
 */
export async function acceptInvitation(
  db: Db,
  input: {
    token: string;
    sessionUser: { id: string; email: string } | null;
    password: string | null;
  },
): Promise<{ ok: true; userId: string; workspaceId: string; role: InvitableRole } | Failure> {
  const [invite] = await db
    .select({
      id: invitations.id,
      workspaceId: invitations.workspaceId,
      email: invitations.email,
      role: invitations.role,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
      tokenId: invitations.tokenId,
      tokenUsedAt: authTokens.usedAt,
    })
    .from(authTokens)
    .innerJoin(invitations, eq(invitations.tokenId, authTokens.id))
    .where(and(eq(authTokens.tokenHash, hashToken(input.token)), eq(authTokens.purpose, "invite")));
  if (!invite || invite.status !== "pending" || invite.tokenUsedAt || invite.expiresAt <= new Date()) {
    return fail("api.inviteInvalid", 400);
  }

  if (input.sessionUser && input.sessionUser.email.toLowerCase() !== invite.email) {
    return fail("api.inviteWrongEmail", 403, "wrong_email");
  }
  if (!input.sessionUser) {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, invite.email));
    if (existing) return fail("api.inviteLoginRequired", 401, "login_required");
    if ((input.password?.length ?? 0) < MIN_PASSWORD_LENGTH) {
      return fail("api.passwordMin", 400, "password_required", { min: MIN_PASSWORD_LENGTH });
    }
  }
  const passwordHash = input.sessionUser ? null : await hashPassword(input.password!);

  try {
    return await db.transaction(async (tx) => {
      // The status guard makes a double accept lose the race here.
      const [claimed] = await tx
        .update(invitations)
        .set({ status: "accepted" })
        .where(and(eq(invitations.id, invite.id), eq(invitations.status, "pending")))
        .returning({ id: invitations.id });
      if (!claimed) throw new Abort(fail("api.inviteInvalid", 400));
      await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, invite.tokenId));

      let userId = input.sessionUser?.id;
      if (!userId) {
        const [created] = await tx
          .insert(users)
          .values({ email: invite.email, passwordHash: passwordHash!, emailVerifiedAt: new Date() })
          .onConflictDoNothing({ target: users.email })
          .returning({ id: users.id });
        if (!created) throw new Abort(fail("api.inviteLoginRequired", 401, "login_required"));
        userId = created.id;
      }

      const [joined] = await tx
        .insert(memberships)
        .values({ workspaceId: invite.workspaceId, userId, role: invite.role })
        .onConflictDoNothing()
        .returning({ userId: memberships.userId });
      if (!joined) throw new Abort(fail("api.inviteAlreadyMember", 409));
      return { ok: true as const, userId, workspaceId: invite.workspaceId, role: invite.role };
    });
  } catch (error) {
    if (error instanceof Abort) return error.failure;
    throw error;
  }
}
