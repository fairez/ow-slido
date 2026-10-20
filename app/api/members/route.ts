import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { listMembers } from "@/lib/members";

export async function GET(request: Request) {
  const auth = await requireMember(request, "members.manage");
  if (!auth.ok) return auth.response;
  return Response.json({ members: await listMembers(getDb(), auth.workspaceId), selfId: auth.user.id });
}
