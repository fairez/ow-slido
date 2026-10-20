import { isUuid } from "@/lib/events";
import { serverT } from "@/lib/i18n/server";
import { getParticipantQaView } from "@/lib/question-routes";

type Context = { params: Promise<{ id: string }> };

/** The Q&A tab for the calling participant: the live (else latest) Q&A plus earlier closed ones. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });
  return getParticipantQaView(request, id);
}
