import { serverT, apiMessage } from "@/lib/i18n/server";
import { asc, eq } from "drizzle-orm";
import { events } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { generateUniqueJoinCode, parseEventInput } from "@/lib/events";

const UNIQUE_VIOLATION = "23505";

async function isCodeFree(code: string) {
  const rows = await getDb().select({ id: events.id }).from(events).where(eq(events.joinCode, code));
  return rows.length === 0;
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const parsed = parseEventInput(await request.json().catch(() => null), false);
  if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });
  const { name, startsAt, endsAt, moderationMode } = parsed.value;

  // A concurrent create can take the code between the check and the insert; retry on that.
  for (let attempt = 0; attempt < 3; attempt++) {
    const joinCode = await generateUniqueJoinCode(isCodeFree);
    try {
      const [event] = await getDb()
        .insert(events)
        .values({ ownerId: auth.user.id, name: name!, startsAt: startsAt!, endsAt: endsAt!, moderationMode, joinCode })
        .returning();
      return Response.json({ event }, { status: 201 });
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
    }
  }
  return Response.json({ error: serverT(request, "api.joinCodeFailed") }, { status: 500 });
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const list = await getDb()
    .select()
    .from(events)
    .where(eq(events.ownerId, auth.user.id))
    .orderBy(asc(events.startsAt), asc(events.createdAt));
  return Response.json({ events: list });
}
