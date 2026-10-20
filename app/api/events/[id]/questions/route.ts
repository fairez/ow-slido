import { serverT } from "@/lib/i18n/server";
import { isUuid } from "@/lib/events";
import { getDb } from "@/lib/db";
import { getQuestions, postQuestion } from "@/lib/question-routes";
import { resolveEventQa } from "@/lib/questions";

type Context = { params: Promise<{ id: string }> };

const notFound = (request: Request) => Response.json({ error: serverT(request, "api.eventNotFound") }, { status: 404 });

/** Event-level path: files the question under the event's live Q&A, else its first (created if none). */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  if (!isUuid(id)) return notFound(request);
  return postQuestion(request, id, null);
}

/** Approved questions of the event's live (else first) Q&A, for its participants and its host. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  if (!isUuid(id)) return notFound(request);
  return getQuestions(request, id, await resolveEventQa(getDb(), id));
}
