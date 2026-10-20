import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { listMembers } from "@/lib/members";
import { reconcileSeats } from "@/lib/seats";

export async function GET(request: Request) {
  const auth = await requireMember(request, "members.manage");
  if (!auth.ok) return auth.response;
  // Catches up a plan change the webhook or the daily sweep has not applied yet.
  await reconcileSeats(auth.workspaceId);
  return Response.json({ members: await listMembers(getDb(), auth.workspaceId), selfId: auth.user.id });
}
