import { serverT, apiMessage } from "@/lib/i18n/server";
import { asc, eq } from "drizzle-orm";
import { events, interactions } from "@/db/schema";
import { QA_DEFAULT_TITLE, newInteractionConfig } from "@/lib/interaction-config";
import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { generateUniqueJoinCode, parseEventInput } from "@/lib/events";
import { PlanLimitError, assertCanCreateEvent, planLimitResponse } from "@/lib/limits";

const UNIQUE_VIOLATION = "23505";

async function isCodeFree(code: string) {
  const rows = await getDb().select({ id: events.id }).from(events).where(eq(events.joinCode, code));
  return rows.length === 0;
}

export async function POST(request: Request) {
  const auth = await requireMember(request, "event.create");
  if (!auth.ok) return auth.response;

  const parsed = parseEventInput(await request.json().catch(() => null), false);
  if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });
  const { name, startsAt, endsAt, moderationMode } = parsed.value;

  const { workspaceId } = auth;
  try {
    await assertCanCreateEvent(workspaceId);
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }

  // A concurrent create can take the code between the check and the insert; retry on that.
  for (let attempt = 0; attempt < 3; attempt++) {
    const joinCode = await generateUniqueJoinCode(isCodeFree);
    try {
      const event = await getDb().transaction(async (tx) => {
        const [created] = await tx
          .insert(events)
          .values({ ownerId: auth.user.id, createdBy: auth.user.id, workspaceId, name: name!, startsAt: startsAt!, endsAt: endsAt!, moderationMode, joinCode })
          .returning();
        // Every event starts with a Q&A the host can open; it stays a draft until then.
        await tx.insert(interactions).values({
          eventId: created.id,
          createdBy: auth.user.id,
          type: "qa",
          title: QA_DEFAULT_TITLE,
          position: 0,
          config: newInteractionConfig("qa", { moderation: created.moderationMode }),
        });
        return created;
      });
      return Response.json({ event }, { status: 201 });
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
    }
  }
  return Response.json({ error: serverT(request, "api.joinCodeFailed") }, { status: 500 });
}

export async function GET(request: Request) {
  const auth = await requireMember(request);
  if (!auth.ok) return auth.response;

  const list = await getDb()
    .select()
    .from(events)
    .where(eq(events.workspaceId, auth.workspaceId))
    .orderBy(asc(events.startsAt), asc(events.createdAt));
  return Response.json({ events: list });
}
