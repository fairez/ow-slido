import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { createDb } from "@/db/client";
import { memberships, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { ROLES, type Role } from "@/lib/auth/permissions";
import type { MessageKey } from "@/lib/i18n/en";
import { revokeMemberSockets } from "@/lib/realtime/publisher";

type Db = ReturnType<typeof createDb>["db"];

export type MemberStatus = "active" | "suspended";
export type MemberFailure = { ok: false; error: MessageKey; status: number; reason?: string };
const fail = (error: MessageKey, status: number, reason?: string): MemberFailure => ({ ok: false, error, status, reason });

export type Actor = { userId: string; role: Role };
type Target = { userId: string; role: Role; status: MemberStatus };

export function parseMemberPatch(
  body: unknown,
): { ok: true; value: { role: Role } | { status: MemberStatus } } | MemberFailure {
  const raw = body as { role?: unknown; status?: unknown } | null;
  if (!raw || typeof raw !== "object") return fail("api.invalidBody", 400);
  const hasRole = raw.role !== undefined;
  const hasStatus = raw.status !== undefined;
  if (hasRole === hasStatus) return fail("api.invalidBody", 400);
  if (hasRole) {
    const role = ROLES.find((r) => r === raw.role);
    return role ? { ok: true, value: { role } } : fail("api.memberRoleInvalid", 400);
  }
  return raw.status === "active" || raw.status === "suspended"
    ? { ok: true, value: { status: raw.status } }
    : fail("api.memberStatusInvalid", 400);
}

export async function listMembers(db: Db, workspaceId: string) {
  return db
    .select({
      userId: users.id,
      email: users.email,
      role: memberships.role,
      status: memberships.status,
      joinedAt: memberships.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(asc(memberships.createdAt), asc(users.email));
}

class Abort extends Error {
  constructor(readonly failure: MemberFailure) {
    super(failure.error);
  }
}

/**
 * Runs `change` on a member while the workspace's owner rows are locked, so two requests cannot together
 * remove the last active owner. Admins may not touch owners; `change` adds the rules of its own action.
 */
async function withTarget<T>(
  db: Db,
  workspaceId: string,
  actor: Actor,
  targetId: string,
  change: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0], target: Target, lastActiveOwner: boolean) => Promise<T>,
): Promise<T | MemberFailure> {
  try {
    return await db.transaction(async (tx) => {
      const owners = await tx
        .select({ userId: memberships.userId, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "owner")))
        .for("update");
      const [target] = await tx
        .select({ userId: memberships.userId, role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, targetId)));
      if (!target) throw new Abort(fail("api.memberNotFound", 404));
      if (target.role === "owner" && actor.role !== "owner") throw new Abort(fail("api.memberOwnerOnly", 403));
      const activeOwners = owners.filter((o) => o.status === "active");
      const lastActiveOwner =
        target.role === "owner" && target.status === "active" && activeOwners.length === 1 && activeOwners[0].userId === targetId;
      return await change(tx, target, lastActiveOwner);
    });
  } catch (error) {
    if (error instanceof Abort) return error.failure;
    throw error;
  }
}

export async function changeMemberRole(db: Db, workspaceId: string, actor: Actor, targetId: string, role: Role) {
  if (role === "owner" && actor.role !== "owner") return fail("api.memberOwnerOnly", 403);
  const result = await withTarget(db, workspaceId, actor, targetId, async (tx, target, lastActiveOwner) => {
    if (target.role === role) throw new Abort(fail("api.nothingToChange", 400));
    if (lastActiveOwner) throw new Abort(fail("api.memberLastOwner", 409, "last_owner"));
    await tx
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, targetId)));
    return { ok: true as const };
  });
  if (result.ok) revokeMemberSockets(targetId, workspaceId);
  return result;
}

export async function setMemberStatus(
  db: Db,
  workspaceId: string,
  actor: Actor,
  targetId: string,
  status: MemberStatus,
) {
  if (status === "suspended" && actor.userId === targetId) return fail("api.memberSelfSuspend", 400);
  const result = await withTarget(db, workspaceId, actor, targetId, async (tx, target, lastActiveOwner) => {
    if (target.status === status) throw new Abort(fail("api.nothingToChange", 400));
    if (status === "suspended" && lastActiveOwner) throw new Abort(fail("api.memberLastOwner", 409, "last_owner"));
    await tx
      .update(memberships)
      .set({ status })
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, targetId)));
    return { ok: true as const };
  });
  if (result.ok && status === "suspended") revokeMemberSockets(targetId, workspaceId);
  return result;
}

/** Deletes the membership only. Events and everything under them belong to the workspace and stay. */
export async function removeMember(db: Db, workspaceId: string, actor: Actor, targetId: string) {
  const result = await withTarget(db, workspaceId, actor, targetId, async (tx, _target, lastActiveOwner) => {
    if (lastActiveOwner) throw new Abort(fail("api.memberLastOwner", 409, "last_owner"));
    await tx.delete(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, targetId)));
    return { ok: true as const };
  });
  if (result.ok) revokeMemberSockets(targetId, workspaceId);
  return result;
}

/**
 * Gives the member a random password, forces a change at next login and ends their other sessions.
 * Returns the password once; only its hash is stored. It applies to the whole account, not one workspace.
 */
export async function resetMemberPassword(db: Db, workspaceId: string, actor: Actor, targetId: string) {
  if (actor.userId === targetId) return fail("api.memberSelfReset", 400);
  const temporaryPassword = randomBytes(12).toString("base64url");
  const passwordHash = await hashPassword(temporaryPassword);
  const result = await withTarget(db, workspaceId, actor, targetId, async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: true, sessionsValidAfter: new Date() })
      .where(eq(users.id, targetId));
    return { ok: true as const };
  });
  return result.ok ? { ok: true as const, temporaryPassword } : result;
}
