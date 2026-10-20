import { serverT } from "@/lib/i18n/server";
import { eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/events";
import { getPublishedAnalysis } from "@/lib/note-analysis";
import { readParticipantToken, verifyParticipantToken } from "@/lib/participant-token";
import { AUDIENCE_READ_IP_LIMIT, clientIp, rateLimit } from "@/lib/rate-limit";

type Context = { params: Promise<{ id: string }> };

/** What participants may see of an analysis: the published one only, or `analysis: null`. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;

  const ip = await rateLimit(`analysis:public:ip:${clientIp(request)}`, AUDIENCE_READ_IP_LIMIT, 60);
  if (!ip.allowed) {
    return Response.json({ error: serverT(request, "api.tooManyRequests") }, { status: 429, headers: { "Retry-After": String(ip.retryAfterSeconds) } });
  }

  const [row] = isUuid(id)
    ? await getDb().select({ eventId: interactions.eventId, type: interactions.type, state: interactions.state }).from(interactions).where(eq(interactions.id, id))
    : [];
  if (!row || row.type !== "sharedNotes" || row.state === "draft") return Response.json({ error: serverT(request, "api.interactionNotFound") }, { status: 404 });

  const token = readParticipantToken(request, row.eventId);
  const participantId = token ? verifyParticipantToken(token, row.eventId) : null;
  if (!participantId) return Response.json({ error: serverT(request, "api.joinFirst") }, { status: 401 });

  return Response.json({ analysis: await getPublishedAnalysis(id) });
}
