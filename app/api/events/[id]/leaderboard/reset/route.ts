import { requireMember } from "@/lib/auth/require-admin";
import { resetLeaderboard } from "@/lib/leaderboard";
import { eventNotFound, findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string }> };

/** Clears the event's quiz scores; questions that close afterwards start a new tally. */
export async function POST(request: Request, { params }: Context) {
  const auth = await requireMember(request, "live.run");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const event = await findOwnedEvent(id, auth.workspaceId);
  if (!event) return eventNotFound(request);

  await resetLeaderboard(event.id);
  return Response.json({ ok: true });
}
