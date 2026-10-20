import { serverT } from "@/lib/i18n/server";
import { and, asc, eq } from "drizzle-orm";
import { events, interactions } from "@/db/schema";
import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { EVENT_NAME_MAX, generateUniqueJoinCode, isUuid } from "@/lib/events";
import { PlanLimitError, assertCanCreateEvent, planLimitResponse } from "@/lib/limits";
import { assertNotOverLimit } from "@/lib/over-limit";
import { getEntitlements } from "@/lib/plans";

type Context = { params: Promise<{ id: string }> };

const UNIQUE_VIOLATION = "23505";

async function isCodeFree(code: string) {
  const rows = await getDb().select({ id: events.id }).from(events).where(eq(events.joinCode, code));
  return rows.length === 0;
}

/** Copies the event settings and its interactions (as drafts); responses, participants and Q&A stay behind. */
export async function POST(request: Request, { params }: Context) {
  const auth = await requireMember(request, "event.create");
  if (!auth.ok) return auth.response;

  const id = (await params).id;
  const [source] = isUuid(id)
    ? await getDb()
        .select()
        .from(events)
        .where(and(eq(events.id, id), eq(events.workspaceId, auth.workspaceId)))
    : [];
  if (!source) return Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });
  try {
    await assertNotOverLimit(auth.workspaceId, { eventId: source.id });
    await assertCanCreateEvent(auth.workspaceId);
  } catch (error) {
    if (error instanceof PlanLimitError) return planLimitResponse(request, error);
    throw error;
  }

  // Types the plan no longer includes are not carried over: a copy would be read-only from the start.
  const { limits } = await getEntitlements(auth.workspaceId);
  const copies = (
    await getDb()
      .select()
      .from(interactions)
      .where(eq(interactions.eventId, source.id))
      .orderBy(asc(interactions.position), asc(interactions.createdAt))
  ).filter((i) => limits.allowedTypes.includes(i.type));
  const name = `${source.name} (copy)`.slice(0, EVENT_NAME_MAX);

  for (let attempt = 0; attempt < 3; attempt++) {
    const joinCode = await generateUniqueJoinCode(isCodeFree);
    try {
      const event = await getDb().transaction(async (tx) => {
        const [created] = await tx
          .insert(events)
          .values({
            ownerId: auth.user.id,
            createdBy: auth.user.id,
            workspaceId: source.workspaceId,
            name,
            startsAt: source.startsAt,
            endsAt: source.endsAt,
            moderationMode: source.moderationMode,
            audienceLocale: source.audienceLocale,
            joinCode,
          })
          .returning();
        if (copies.length > 0) {
          await tx.insert(interactions).values(
            copies.map((i, index) => ({
              eventId: created.id,
              createdBy: auth.user.id,
              type: i.type,
              title: i.title,
              state: "draft" as const,
              position: index,
              config: i.config,
            })),
          );
        }
        return created;
      });
      return Response.json({ event }, { status: 201 });
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
    }
  }
  return Response.json({ error: serverT(request, "api.joinCodeFailed") }, { status: 500 });
}
