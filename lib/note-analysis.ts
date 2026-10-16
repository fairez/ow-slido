import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { interactions, noteAnalyses, sharedNotes } from "@/db/schema";
import { getDb } from "@/lib/db";
import { publish } from "@/lib/realtime/publisher";
import { applyEdit, type AnalysisEdit, type EditableCategory, type EditableKeyword } from "@/lib/analysis-edit";

/** A job that has not finished after this long is treated as lost (for example after a restart). */
export const ANALYSIS_STALE_MS = 5 * 60_000;

export type AnalysisNote = { id: string; text: string };

export type AnalysisOutput = {
  summary: string;
  categories: unknown;
  keywords: unknown;
  model: string;
  promptVersion: string;
  /** Plain-language reason shown to the host when the result is a fallback. */
  notice?: string;
};

export type AnalysisRunner = (input: {
  eventId: string;
  interactionId: string;
  notes: AnalysisNote[];
}) => Promise<AnalysisOutput>;

let runner: AnalysisRunner | null = null;

/** The AI step plugs in here; tests pass their own runner. */
export function setAnalysisRunner(next: AnalysisRunner | null) {
  runner = next;
}

export type AnalysisView = {
  id: string;
  interactionId: string;
  status: "queued" | "running" | "done" | "failed";
  noteCount: number;
  summary: string | null;
  categories: unknown;
  keywords: unknown;
  edited: boolean;
  published: boolean;
  model: string | null;
  promptVersion: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** True when the approved notes have changed since this analysis was started. */
  outdated: boolean;
};

type Db = ReturnType<typeof getDb>;
type Row = typeof noteAnalyses.$inferSelect;

export function hashNotes(notes: AnalysisNote[]) {
  const hash = createHash("sha256");
  for (const n of [...notes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    hash.update(`${n.id}\n${n.text}\n`);
  }
  return hash.digest("hex");
}

async function approvedNotes(db: Db, interactionId: string): Promise<AnalysisNote[]> {
  return db
    .select({ id: sharedNotes.id, text: sharedNotes.text })
    .from(sharedNotes)
    .where(and(eq(sharedNotes.interactionId, interactionId), eq(sharedNotes.status, "approved")))
    .orderBy(asc(sharedNotes.createdAt), asc(sharedNotes.id));
}

function view(row: Row, currentHash: string): AnalysisView {
  const { notesSnapshotHash, ...rest } = row;
  return { ...rest, outdated: notesSnapshotHash !== currentHash };
}

export async function getLatestAnalysis(interactionId: string): Promise<AnalysisView | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(noteAnalyses)
    .where(eq(noteAnalyses.interactionId, interactionId))
    .orderBy(desc(noteAnalyses.createdAt))
    .limit(1);
  if (!row) return null;
  return view(row, hashNotes(await approvedNotes(db, interactionId)));
}

export type StartResult =
  | { ok: true; analysis: AnalysisView; done: Promise<void> }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Creates a queued job and starts it in the background. Only called from the host's explicit
 * request; nothing else in the app may call it.
 */
export async function startAnalysis(eventId: string, interactionId: string): Promise<StartResult> {
  const db = getDb();
  const created = await db.transaction(async (tx) => {
    // The interaction row lock serialises concurrent starts for the same interaction.
    await tx.execute(sql`SELECT 1 FROM interactions WHERE id = ${interactionId} FOR UPDATE`);
    await tx
      .update(noteAnalyses)
      .set({ status: "failed", error: "The analysis did not finish.", finishedAt: new Date() })
      .where(
        and(
          eq(noteAnalyses.interactionId, interactionId),
          inArray(noteAnalyses.status, ["queued", "running"]),
          sql`${noteAnalyses.createdAt} < ${new Date(Date.now() - ANALYSIS_STALE_MS)}`,
        ),
      );
    const [active] = await tx
      .select({ id: noteAnalyses.id })
      .from(noteAnalyses)
      .where(and(eq(noteAnalyses.interactionId, interactionId), inArray(noteAnalyses.status, ["queued", "running"])))
      .limit(1);
    if (active) return { kind: "rejected" as const, error: "An analysis is already running", status: 409 as const };

    const notes = await approvedNotes(tx as unknown as Db, interactionId);
    if (notes.length === 0) return { kind: "rejected" as const, error: "There are no approved notes to analyze", status: 400 as const };
    const [row] = await tx
      .insert(noteAnalyses)
      .values({ interactionId, notesSnapshotHash: hashNotes(notes), noteCount: notes.length })
      .returning();
    return { kind: "created" as const, row, notes };
  });
  if (created.kind === "rejected") return { ok: false, status: created.status, error: created.error };

  const { row, notes } = created;
  const done = runJob(row.id, eventId, interactionId, notes);
  return { ok: true, analysis: view(row, row.notesSnapshotHash), done };
}

async function runJob(id: string, eventId: string, interactionId: string, notes: AnalysisNote[]) {
  const db = getDb();
  try {
    await db.update(noteAnalyses).set({ status: "running" }).where(eq(noteAnalyses.id, id));
    // Let the caller return before the work begins.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!runner) throw new Error("Analysis is not available");
    const out = await runner({ eventId, interactionId, notes });
    await db
      .update(noteAnalyses)
      .set({
        status: "done",
        summary: out.summary,
        categories: out.categories,
        keywords: out.keywords,
        model: out.model,
        promptVersion: out.promptVersion,
        error: out.notice ?? null,
        finishedAt: new Date(),
      })
      .where(eq(noteAnalyses.id, id));
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : "The analysis failed";
    await db
      .update(noteAnalyses)
      .set({ status: "failed", error: message.slice(0, 300), finishedAt: new Date() })
      .where(eq(noteAnalyses.id, id))
      .catch(() => {});
  }
}

export type AnalysisPanelState = {
  /** The newest job, whatever its status. */
  latest: AnalysisView | null;
  /** The newest finished job; shown beside a failed latest one so the host keeps the last good result. */
  lastDone: AnalysisView | null;
  approvedNoteCount: number;
  /** Approved note text, so the host can review which notes sit in which category. */
  notes: AnalysisNote[];
};

export async function getAnalysisPanelState(interactionId: string): Promise<AnalysisPanelState> {
  const db = getDb();
  const notes = await approvedNotes(db, interactionId);
  const hash = hashNotes(notes);
  const [latest] = await db
    .select()
    .from(noteAnalyses)
    .where(eq(noteAnalyses.interactionId, interactionId))
    .orderBy(desc(noteAnalyses.createdAt))
    .limit(1);
  const [lastDone] =
    latest && latest.status !== "done"
      ? await db
          .select()
          .from(noteAnalyses)
          .where(and(eq(noteAnalyses.interactionId, interactionId), eq(noteAnalyses.status, "done")))
          .orderBy(desc(noteAnalyses.createdAt))
          .limit(1)
      : [latest];
  return {
    latest: latest ? view(latest, hash) : null,
    lastDone: lastDone ? view(lastDone, hash) : null,
    approvedNoteCount: notes.length,
    notes,
  };
}

/**
 * Publishes or unpublishes the newest finished analysis. At most one analysis per interaction is
 * published, so publishing a newer run withdraws the older one.
 */
export async function setAnalysisPublished(interactionId: string, published: boolean): Promise<AnalysisView | null> {
  const result = await setPublishedFlag(interactionId, published);
  if (result) await announcePublishedAnalysis(interactionId);
  return result;
}

async function setPublishedFlag(interactionId: string, published: boolean): Promise<AnalysisView | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(noteAnalyses)
      .where(and(eq(noteAnalyses.interactionId, interactionId), eq(noteAnalyses.status, "done")))
      .orderBy(desc(noteAnalyses.createdAt))
      .limit(1);
    if (!target) return null;
    await tx.update(noteAnalyses).set({ published: false }).where(eq(noteAnalyses.interactionId, interactionId));
    const [row] = await tx.update(noteAnalyses).set({ published }).where(eq(noteAnalyses.id, target.id)).returning();
    return view(row, hashNotes(await approvedNotes(tx as unknown as Db, interactionId)));
  });
}

export type PublicAnalysis = {
  summary: string;
  categories: { name: string; description: string; count: number }[];
  keywords: { word: string; weight: number }[];
};

/**
 * The analysis a participant may see: only the published one, with category counts instead of note ids.
 * Returns null when nothing is published.
 */
export async function getPublishedAnalysis(interactionId: string): Promise<PublicAnalysis | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(noteAnalyses)
    .where(and(eq(noteAnalyses.interactionId, interactionId), eq(noteAnalyses.status, "done"), eq(noteAnalyses.published, true)))
    .orderBy(desc(noteAnalyses.createdAt))
    .limit(1);
  if (!row) return null;
  const approved = new Set((await approvedNotes(db, interactionId)).map((n) => n.id));
  return {
    summary: row.summary ?? "",
    categories: storedCategories(row.categories)
      .map((c) => ({ name: c.name, description: c.description, count: c.noteIds.filter((id) => approved.has(id)).length }))
      .filter((c) => c.count > 0),
    keywords: storedKeywords(row.keywords),
  };
}

/** Tells participants the published analysis changed (published, withdrawn or edited). */
export async function announcePublishedAnalysis(interactionId: string) {
  const found = await findNotesInteractionEvent(interactionId);
  if (!found) return;
  publish(found.eventId, "analysis:published", { interactionId, analysis: await getPublishedAnalysis(interactionId) });
}

export async function findNotesInteractionEvent(interactionId: string) {
  const [row] = await getDb()
    .select({ eventId: interactions.eventId, type: interactions.type })
    .from(interactions)
    .where(eq(interactions.id, interactionId));
  return row && row.type === "sharedNotes" ? row : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function storedCategories(raw: unknown): EditableCategory[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) =>
    isRecord(c) && typeof c.name === "string" && Array.isArray(c.noteIds)
      ? [
          {
            name: c.name,
            description: typeof c.description === "string" ? c.description : "",
            noteIds: c.noteIds.filter((x): x is string => typeof x === "string"),
          },
        ]
      : [],
  );
}

function storedKeywords(raw: unknown): EditableKeyword[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((k) => (isRecord(k) && typeof k.word === "string" && typeof k.weight === "number" ? [{ word: k.word, weight: k.weight }] : []));
}

export type EditOutcome = { ok: true; analysis: AnalysisView } | { ok: false; status: 400 | 409; error: string };

/** Applies a host edit to the newest finished analysis and marks it edited. */
export async function editAnalysis(interactionId: string, edit: AnalysisEdit): Promise<EditOutcome> {
  const outcome = await editAnalysisRow(interactionId, edit);
  if (outcome.ok && outcome.analysis.published) await announcePublishedAnalysis(interactionId);
  return outcome;
}

async function editAnalysisRow(interactionId: string, edit: AnalysisEdit): Promise<EditOutcome> {
  return getDb().transaction(async (tx): Promise<EditOutcome> => {
    const found = await tx.execute(
      sql`SELECT id FROM note_analyses WHERE interaction_id = ${interactionId} AND status = 'done' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    );
    const target = (found.rows[0] as { id: string } | undefined)?.id;
    if (!target) return { ok: false, status: 409, error: "There is no finished analysis to edit" };
    const [row] = await tx.select().from(noteAnalyses).where(eq(noteAnalyses.id, target));
    const notes = await approvedNotes(tx as unknown as Db, interactionId);
    if (edit.op === "moveNote" && !notes.some((n) => n.id === edit.noteId)) {
      return { ok: false, status: 400, error: "That note is no longer approved." };
    }
    const result = applyEdit(
      { summary: row.summary, categories: storedCategories(row.categories), keywords: storedKeywords(row.keywords) },
      edit,
    );
    if (!result.ok) return { ok: false, status: 400, error: result.error };
    const [saved] = await tx
      .update(noteAnalyses)
      .set({
        summary: result.value.summary,
        categories: result.value.categories,
        keywords: result.value.keywords,
        edited: true,
      })
      .where(eq(noteAnalyses.id, target))
      .returning();
    return { ok: true, analysis: view(saved, hashNotes(notes)) };
  });
}
