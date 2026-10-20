import { apiMessage } from "@/lib/i18n/server";
import { denyUnlessVerified, requireMember } from "@/lib/auth/require-admin";
import { startInteraction } from "@/lib/interaction-state";
import { PlanLimitError, planLimitResponse } from "@/lib/limits";
import { assertNotOverLimit } from "@/lib/over-limit";
import { eventNotFound, findInteraction, findOwnedEvent, interactionNotFound } from "@/lib/polls";

type Context = { params: Promise<{ id: string; interactionId: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireMember(request, "live.run");
  if (!auth.ok) return auth.response;
  const unverified = denyUnlessVerified(request, auth.user);
  if (unverified) return unverified;
  const { id, interactionId } = await params;
  const event = await findOwnedEvent(id, auth.workspaceId);
  if (!event) return eventNotFound(request);
  const interaction = await findInteraction(event.id, interactionId);
  if (!interaction) return interactionNotFound(request);
  try {
    await assertNotOverLimit(auth.workspaceId, { eventId: event.id, type: interaction.type });
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }

  const result = await startInteraction(event.id, interactionId);
  if (!result.ok) return Response.json({ error: apiMessage(request, result) }, { status: 409 });
  return Response.json({ interaction: result.interaction });
}
