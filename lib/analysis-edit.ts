import type { MessageKey, TParams } from "@/lib/i18n";
/** Host edits to a stored analysis. Db-free so the rules can be tested and reused on the client. */

export const UNCATEGORIZED_NAME = "Uncategorized";
export const CATEGORY_NAME_MAX = 60;
export const SUMMARY_MAX = 3000;

export type EditableCategory = { name: string; description: string; noteIds: string[] };
export type EditableKeyword = { word: string; weight: number };

export type EditState = {
  summary: string | null;
  categories: EditableCategory[];
  keywords: EditableKeyword[];
};

export type AnalysisEdit =
  | { op: "renameCategory"; name: string; to: string }
  | { op: "mergeCategories"; from: string; into: string }
  | { op: "deleteCategory"; name: string }
  | { op: "moveNote"; noteId: string; to: string }
  | { op: "setSummary"; summary: string }
  | { op: "removeKeyword"; word: string };

export type EditResult = { ok: true; value: EditState } | { ok: false; error: MessageKey; params?: TParams };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const fail = (error: MessageKey, params?: TParams): EditResult => ({ ok: false, error, params });

function find(categories: EditableCategory[], name: string) {
  return categories.findIndex((c) => same(c.name, name));
}

/** Empty categories are dropped so the charts never show a zero row. */
function tidy(categories: EditableCategory[]) {
  return categories.filter((c) => c.noteIds.length > 0);
}

/** Moves note ids into the named category, creating Uncategorized when it is the target. */
function addTo(categories: EditableCategory[], name: string, ids: string[]): EditableCategory[] | null {
  const next = categories.map((c) => ({ ...c, noteIds: [...c.noteIds] }));
  let at = find(next, name);
  if (at === -1) {
    if (!same(name, UNCATEGORIZED_NAME)) return null;
    next.push({ name: UNCATEGORIZED_NAME, description: "", noteIds: [] });
    at = next.length - 1;
  }
  const have = new Set(next[at].noteIds);
  for (const id of ids) if (!have.has(id)) next[at].noteIds.push(id);
  return next;
}

/** Applies one edit and returns the new state, or a message for the host. Never drops a note. */
export function applyEdit(state: EditState, edit: AnalysisEdit): EditResult {
  const { categories } = state;
  switch (edit.op) {
    case "renameCategory": {
      const to = edit.to.trim();
      if (!to) return fail("api.categoryNameRequired");
      if (to.length > CATEGORY_NAME_MAX) return fail("api.categoryNameMax", { max: CATEGORY_NAME_MAX });
      const at = find(categories, edit.name);
      if (at === -1) return fail("api.categoryGone");
      if (categories.some((c, i) => i !== at && same(c.name, to))) {
        return fail("api.categoryExists");
      }
      const next = categories.map((c, i) => (i === at ? { ...c, name: to } : c));
      return { ok: true, value: { ...state, categories: next } };
    }
    case "mergeCategories": {
      const from = find(categories, edit.from);
      const into = find(categories, edit.into);
      if (from === -1 || into === -1) return fail("api.categoryGone");
      if (from === into) return fail("api.mergeSame");
      const moved = addTo(categories, categories[into].name, categories[from].noteIds);
      if (!moved) return fail("api.categoryGone");
      return { ok: true, value: { ...state, categories: moved.filter((c) => !same(c.name, categories[from].name)) } };
    }
    case "deleteCategory": {
      const at = find(categories, edit.name);
      if (at === -1) return fail("api.categoryGone");
      if (same(categories[at].name, UNCATEGORIZED_NAME)) return fail("api.uncategorizedKeep");
      const rest = categories.filter((_, i) => i !== at);
      const next = addTo(rest, UNCATEGORIZED_NAME, categories[at].noteIds);
      return { ok: true, value: { ...state, categories: next ?? rest } };
    }
    case "moveNote": {
      const stripped = categories.map((c) => ({ ...c, noteIds: c.noteIds.filter((id) => id !== edit.noteId) }));
      const next = addTo(stripped, edit.to, [edit.noteId]);
      if (!next) return fail("api.categoryGone");
      return { ok: true, value: { ...state, categories: tidy(next) } };
    }
    case "setSummary": {
      const summary = edit.summary.trim();
      if (!summary) return fail("api.summaryEmpty");
      if (summary.length > SUMMARY_MAX) return fail("api.summaryMax", { max: SUMMARY_MAX });
      return { ok: true, value: { ...state, summary } };
    }
    case "removeKeyword": {
      const keywords = state.keywords.filter((k) => !same(k.word, edit.word));
      if (keywords.length === state.keywords.length) return fail("api.keywordRemoved");
      return { ok: true, value: { ...state, keywords } };
    }
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Validates a request body into an edit. */
export function parseEdit(body: unknown): { ok: true; value: AnalysisEdit } | { ok: false; error: MessageKey; params?: TParams } {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const bad = { ok: false as const, error: "api.editInvalid" as MessageKey };
  switch (b.op) {
    case "renameCategory": {
      const name = str(b.name), to = str(b.to);
      return name !== null && to !== null ? { ok: true, value: { op: "renameCategory", name, to } } : bad;
    }
    case "mergeCategories": {
      const from = str(b.from), into = str(b.into);
      return from !== null && into !== null ? { ok: true, value: { op: "mergeCategories", from, into } } : bad;
    }
    case "deleteCategory": {
      const name = str(b.name);
      return name !== null ? { ok: true, value: { op: "deleteCategory", name } } : bad;
    }
    case "moveNote": {
      const noteId = str(b.noteId), to = str(b.to);
      return noteId !== null && to !== null ? { ok: true, value: { op: "moveNote", noteId, to } } : bad;
    }
    case "setSummary": {
      const summary = str(b.summary);
      return summary !== null ? { ok: true, value: { op: "setSummary", summary } } : bad;
    }
    case "removeKeyword": {
      const word = str(b.word);
      return word !== null ? { ok: true, value: { op: "removeKeyword", word } } : bad;
    }
    default:
      return bad;
  }
}
