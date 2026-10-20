import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { apiMessage, serverT } from "@/lib/i18n/server";
import { PlanLimitError, planLimitResponse } from "@/lib/limits";
import { changeMemberRole, parseMemberPatch, removeMember, setMemberStatus } from "@/lib/members";

type Context = { params: Promise<{ userId: string }> };

const notFound = (request: Request) =>
  Response.json({ error: serverT(request, "api.memberNotFound") }, { status: 404 });

/** Body is `{ role }` to change the role or `{ status: "active" | "suspended" }` to reactivate or suspend. */
export async function PATCH(request: Request, { params }: Context) {
  const auth = await requireMember(request, "members.manage");
  if (!auth.ok) return auth.response;
  const userId = (await params).userId;
  if (!isUuid(userId)) return notFound(request);

  const parsed = parseMemberPatch(await request.json().catch(() => null));
  if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: parsed.status });

  const actor = { userId: auth.user.id, role: auth.role };
  let result;
  try {
    result =
      "role" in parsed.value
        ? await changeMemberRole(getDb(), auth.workspaceId, actor, userId, parsed.value.role)
        : await setMemberStatus(getDb(), auth.workspaceId, actor, userId, parsed.value.status);
  } catch (error) {
    // Reactivating a member needs a free seat.
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }
  if (!result.ok) return failure(request, result);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request, { params }: Context) {
  const auth = await requireMember(request, "members.manage");
  if (!auth.ok) return auth.response;
  const userId = (await params).userId;
  if (!isUuid(userId)) return notFound(request);

  const result = await removeMember(getDb(), auth.workspaceId, { userId: auth.user.id, role: auth.role }, userId);
  if (!result.ok) return failure(request, result);
  return Response.json({ ok: true });
}

function failure(request: Request, result: Parameters<typeof apiMessage>[1] & { status: number; reason?: string }) {
  return Response.json({ error: apiMessage(request, result), reason: result.reason }, { status: result.status });
}
