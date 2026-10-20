import { eq } from "drizzle-orm";
import { templates } from "@/db/schema";
import { requireMember } from "@/lib/auth/require-admin";
import { getDb } from "@/lib/db";
import { apiMessage, serverT } from "@/lib/i18n/server";
import { findTemplate, parseTemplateName } from "@/lib/templates";

type Context = { params: Promise<{ id: string }> };

const notFound = (request: Request) => Response.json({ error: serverT(request, "api.templateNotFound") }, { status: 404 });

export async function PATCH(request: Request, { params }: Context) {
  const auth = await requireMember(request, "templates.manage");
  if (!auth.ok) return auth.response;
  const template = await findTemplate((await params).id, auth.workspaceId);
  if (!template) return notFound(request);

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const parsed = parseTemplateName(body?.name);
  if (!parsed.ok) return Response.json({ error: apiMessage(request, parsed) }, { status: 400 });
  const [updated] = await getDb().update(templates).set({ name: parsed.name }).where(eq(templates.id, template.id)).returning();
  return Response.json({ template: updated });
}

export async function DELETE(request: Request, { params }: Context) {
  const auth = await requireMember(request, "templates.manage");
  if (!auth.ok) return auth.response;
  const template = await findTemplate((await params).id, auth.workspaceId);
  if (!template) return notFound(request);
  await getDb().delete(templates).where(eq(templates.id, template.id));
  return Response.json({ ok: true });
}
