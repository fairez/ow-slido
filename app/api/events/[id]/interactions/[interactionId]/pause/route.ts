import { requireAdmin } from "@/lib/auth/require-admin";
import { pauseInteraction } from "@/lib/interaction-state";
import { eventNotFound, findInteraction, findOwnedEvent, interactionNotFound } from "@/lib/polls";

type Context = { params: Promise<{ id: string; interactionId: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id, interactionId } = await params;
  const event = await findOwnedEvent(id, auth.user.id);
  if (!event) return eventNotFound();
  if (!(await findInteraction(event.id, interactionId))) return interactionNotFound();

  const result = await pauseInteraction(event.id, interactionId);
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
  return Response.json({ interaction: result.interaction });
}
