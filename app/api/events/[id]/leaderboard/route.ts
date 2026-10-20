import { requireMember } from "@/lib/auth/require-admin";
import { getLeaderboardStore } from "@/lib/leaderboard";
import { LEADERBOARD_TOP, topStandings } from "@/lib/leaderboard/standings";
import { eventNotFound, findOwnedEvent } from "@/lib/polls";

type Context = { params: Promise<{ id: string }> };

/** The event's best participants for the host's screens (final podium); `?limit=` is 1 to 10, default 10. */
export async function GET(request: Request, { params }: Context) {
  const auth = await requireMember(request, "live.run");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const event = await findOwnedEvent(id, auth.workspaceId);
  if (!event) return eventNotFound(request);

  const asked = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, LEADERBOARD_TOP) : LEADERBOARD_TOP;
  return Response.json({
    standings: await topStandings(event.id, limit),
    players: await getLeaderboardStore().size(event.id),
  });
}
