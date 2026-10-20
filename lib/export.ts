import { asc, eq } from "drizzle-orm";
import { interactions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { createZip, type ZipEntry } from "@/lib/zip";
import {
  ANALYSIS_EXPORT_HEADER,
  EXPORT_HEADER,
  NOTES_EXPORT_HEADER,
  OPEN_TEXT_EXPORT_HEADER,
  RATING_EXPORT_HEADER,
  INTERACTION_MODULES,
  interactionModule,
  type CsvTable,
} from "@/lib/interaction-modules";

export { ANALYSIS_EXPORT_HEADER, EXPORT_HEADER, NOTES_EXPORT_HEADER, OPEN_TEXT_EXPORT_HEADER, RATING_EXPORT_HEADER };

/** Quotes a field for CSV; a leading formula character is neutralised so spreadsheets don't evaluate user text. */
export function csvField(value: string | number) {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Tables as one CSV text, a blank line between tables. */
export function tablesToCsv(tables: CsvTable[]) {
  const rows: (string | number)[][] = [];
  tables.forEach((table, i) => rows.push(...(i > 0 ? [[]] : []), [...table.header], ...table.rows));
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** The CSV of one interaction, from its type's module. */
export async function buildInteractionCsv(type: string, interactionId: string) {
  return tablesToCsv(await interactionModule(type).csv(interactionId));
}

/**
 * One file for the event: poll option votes, word counts and approved questions with upvotes in the
 * flat table, then one table per other type and the analysis summaries. Interactions are visited in
 * registry order (then position), and tables that share a header are merged.
 * Only aggregates, question text and an optional author name are included, never participant ids.
 */
export async function buildEventCsv(eventId: string) {
  const list = await getDb()
    .select()
    .from(interactions)
    .where(eq(interactions.eventId, eventId))
    .orderBy(asc(interactions.position), asc(interactions.createdAt));

  // The flat table is always first, even when it has no rows.
  const groups = new Map<string, CsvTable>([[EXPORT_HEADER.join(), { header: EXPORT_HEADER, rows: [] }]]);
  for (const mod of INTERACTION_MODULES) {
    for (const interaction of list.filter((i) => i.type === mod.type)) {
      for (const table of await mod.csv(interaction.id)) {
        const key = table.header.join();
        const group = groups.get(key);
        if (group) group.rows.push(...table.rows);
        else groups.set(key, { ...table, rows: [...table.rows] });
      }
    }
  }
  const tables = [...groups.values()];
  return tablesToCsv([...tables.filter((t) => !t.trailing), ...tables.filter((t) => t.trailing)]);
}

/** A title as a file name part: letters and digits, dashes between words, at most 60 characters. */
export function fileSlug(text: string) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60).replace(/-$/, "");
}

/** The per-interaction CSV files of an event, named by position and title (`01-Best-fruit.csv`). */
export async function buildEventFiles(eventId: string): Promise<ZipEntry[]> {
  const list = await getDb()
    .select()
    .from(interactions)
    .where(eq(interactions.eventId, eventId))
    .orderBy(asc(interactions.position), asc(interactions.createdAt));
  const width = Math.max(2, String(list.length).length);
  const entries: ZipEntry[] = [];
  for (const [i, interaction] of list.entries()) {
    const name = `${String(i + 1).padStart(width, "0")}-${fileSlug(interaction.title) || interaction.type}.csv`;
    entries.push({ name, data: await buildInteractionCsv(interaction.type, interaction.id) });
  }
  return entries;
}

/**
 * One CSV per interaction in a ZIP. The files come from each type's module, so they carry the same
 * aggregates as the event CSV and no participant data.
 */
export async function buildEventZip(eventId: string) {
  return createZip(await buildEventFiles(eventId));
}
