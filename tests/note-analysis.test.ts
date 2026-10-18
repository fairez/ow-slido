// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  events,
  interactions,
  noteAnalyses,
  participants,
  sharedNotes,
} from "@/db/schema";
import { createTestDb, truncateAll } from "./helpers/db";

const { db, pool } = createTestDb();

type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;
let eventsRoute: { POST: (req: Request) => Promise<Response> };
let collection: { POST: Handler };
let analyze: { POST: Handler };
let analysis: { GET: Handler; PATCH: Handler };
let closeRoute: {
  POST: (
    req: Request,
    ctx: { params: Promise<{ id: string; interactionId: string }> },
  ) => Promise<Response>;
};
let signup: (req: Request) => Promise<Response>;
let lib: typeof import("@/lib/note-analysis");
let hostCookie: string;
let otherCookie: string;
let eventId: string;
let notesId: string;
let participantId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SESSION_SECRET ||= "test-session-secret";
  eventsRoute = await import("@/app/api/events/route");
  collection = await import("@/app/api/events/[id]/interactions/route");
  analyze = await import("@/app/api/interactions/[id]/analyze/route");
  analysis = await import("@/app/api/interactions/[id]/analysis/route");
  closeRoute =
    await import("@/app/api/events/[id]/interactions/[interactionId]/close/route");
  signup = (await import("@/app/api/auth/signup/route")).POST;
  lib = await import("@/lib/note-analysis");
});

const req = (method: string, body?: unknown, c: string | null = hostCookie) =>
  new Request("http://localhost/api", {
    method,
    headers: {
      "content-type": "application/json",
      ...(c ? { cookie: c } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

const signupAs = async (email: string) => {
  const res = await signup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    }),
  );
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
};
const addNote = async (
  text: string,
  status: "approved" | "pending" = "approved",
) => {
  const [row] = await db
    .insert(sharedNotes)
    .values({ interactionId: notesId, participantId, text, status })
    .returning();
  return row.id;
};
const start = (c: string | null = hostCookie) =>
  analyze.POST(req("POST", { acceptNotice: true }, c), ctx(notesId));
const latest = async () =>
  (await (await analysis.GET(req("GET"), ctx(notesId))).json()).analysis;

const output = {
  summary: "S",
  categories: [{ name: "A", noteIds: [] }],
  keywords: [{ word: "w", weight: 1 }],
  model: "m",
  promptVersion: "v1",
};

beforeEach(async () => {
  await truncateAll(db);
  lib.setAnalysisRunner(async () => output);
  hostCookie = await signupAs("host@example.com");
  otherCookie = await signupAs("other@example.com");
  const ev = await eventsRoute.POST(
    req("POST", {
      name: "E",
      startsAt: "2026-11-01T09:00:00Z",
      endsAt: "2026-11-01T10:00:00Z",
    }),
  );
  eventId = (await ev.json()).event.id;
  const res = await collection.POST(
    req("POST", { type: "sharedNotes", prompt: "Thoughts?" }),
    ctx(eventId),
  );
  notesId = (await res.json()).interaction.id;
  await db
    .update(interactions)
    .set({ state: "live" })
    .where(eq(interactions.id, notesId));
  [{ id: participantId }] = await db
    .insert(participants)
    .values({ eventId })
    .returning();
});
afterAll(async () => {
  lib.setAnalysisRunner(null);
  await pool.end();
});

test("only the owner can start or read an analysis", async () => {
  await addNote("one");
  expect((await start(null)).status).toBe(401);
  expect((await start(otherCookie)).status).toBe(404);
  expect(
    (await analysis.GET(req("GET", undefined, otherCookie), ctx(notesId)))
      .status,
  ).toBe(404);
  expect(await db.select().from(noteAnalyses)).toHaveLength(0);
});

test("start returns immediately with a queued job, then it finishes as done", async () => {
  await addNote("one");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  lib.setAnalysisRunner(async () => {
    await gate;
    return output;
  });
  const res = await start();
  expect(res.status).toBe(202);
  const body = (await res.json()).analysis;
  expect(body.status).toBe("queued");
  expect(body.noteCount).toBe(1);
  expect(body).not.toHaveProperty("notesSnapshotHash");

  await vi.waitFor(async () => expect((await latest()).status).toBe("running"));
  release();
  await vi.waitFor(async () => expect((await latest()).status).toBe("done"));
  const done = await latest();
  expect(done).toMatchObject({
    summary: "S",
    model: "m",
    promptVersion: "v1",
    outdated: false,
    edited: false,
    published: false,
  });
  expect(done.finishedAt).toBeTruthy();
});

test("each status change tells the host pages, with no content", async () => {
  const publisher = await import("@/lib/realtime/publisher");
  const sent: { name: string; payload: unknown; hostOnly?: boolean }[] = [];
  publisher.setPublisher({ publish: (_e, name, payload, options) => void sent.push({ name, payload, hostOnly: options?.hostOnly }) });
  try {
    await addNote("one");
    lib.setAnalysisRunner(async () => output);
    await start();
    await vi.waitFor(async () => expect((await latest()).status).toBe("done"));
    const updates = sent.filter((m) => m.name === "analysis:updated");
    // queued, running and done
    expect(updates.length).toBeGreaterThanOrEqual(3);
    expect(updates.every((m) => m.hostOnly === true)).toBe(true);
    expect(updates.every((m) => JSON.stringify(m.payload) === JSON.stringify({ interactionId: notesId }))).toBe(true);
  } finally {
    publisher.setPublisher(null);
  }
});

test("only one job runs at a time per interaction", async () => {
  await addNote("one");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  lib.setAnalysisRunner(async () => {
    await gate;
    return output;
  });
  expect((await start()).status).toBe(202);
  const second = await start();
  expect(second.status).toBe(409);
  expect(await db.select().from(noteAnalyses)).toHaveLength(1);
  release();
  await vi.waitFor(async () => expect((await latest()).status).toBe("done"));
  expect((await start()).status).toBe(202);
});

test("a failing runner marks the job failed and allows a retry", async () => {
  await addNote("one");
  lib.setAnalysisRunner(async () => {
    throw new Error("boom");
  });
  await start();
  await vi.waitFor(async () => expect((await latest()).status).toBe("failed"));
  expect((await latest()).error).toBe("boom");
  expect((await start()).status).toBe(202);
});

test("a job lost to a restart is failed after the stale window", async () => {
  await addNote("one");
  await db.insert(noteAnalyses).values({
    interactionId: notesId,
    status: "running",
    notesSnapshotHash: "x",
    noteCount: 1,
    createdAt: new Date(Date.now() - lib.ANALYSIS_STALE_MS - 1000),
  });
  expect((await start()).status).toBe(202);
  const rows = await db.select().from(noteAnalyses);
  expect(
    rows.filter((r) => r.error === "The analysis did not finish."),
  ).toHaveLength(1);
});

test("needs at least one approved note", async () => {
  await addNote("waiting", "pending");
  const res = await start();
  expect(res.status).toBe(400);
});

test("analysis is outdated once the approved notes change", async () => {
  const id = await addNote("one");
  await start();
  await vi.waitFor(async () => expect((await latest()).status).toBe("done"));
  expect((await latest()).outdated).toBe(false);

  await addNote("pending only", "pending");
  expect((await latest()).outdated).toBe(false);

  await addNote("two");
  expect((await latest()).outdated).toBe(true);

  await start();
  await vi.waitFor(async () => expect((await latest()).noteCount).toBe(2));
  await vi.waitFor(async () => expect((await latest()).status).toBe("done"));
  expect((await latest()).outdated).toBe(false);

  await db
    .update(sharedNotes)
    .set({ text: "edited" })
    .where(eq(sharedNotes.id, id));
  expect((await latest()).outdated).toBe(true);
});

test("an analysis saved with connectors in its keywords is shown without them", async () => {
  await addNote("one");
  await db.insert(noteAnalyses).values({
    interactionId: notesId,
    notesSnapshotHash: "x",
    noteCount: 1,
    status: "done",
    summary: "S",
    categories: [],
    keywords: [{ word: "dan", weight: 9 }, { word: "yang", weight: 8 }, { word: "wifi", weight: 3 }, { word: "untuk wifi", weight: 1 }],
    model: "m",
    promptVersion: "notes-v1",
    finishedAt: new Date(),
  });
  expect((await latest()).keywords).toEqual([{ word: "wifi", weight: 4 }]);
});

test("returns null before any analysis", async () => {
  expect(await latest()).toBeNull();
});

test("nothing starts automatically on new notes, close or time passing", async () => {
  const runner = vi.fn(async () => output);
  lib.setAnalysisRunner(runner);
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate"] });
  try {
    await addNote("one");
    await addNote("two");
    const closed = await closeRoute.POST(req("POST"), {
      params: Promise.resolve({ id: eventId, interactionId: notesId }),
    });
    expect(closed.status).toBe(200);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  } finally {
    vi.useRealTimers();
  }
  expect(runner).not.toHaveBeenCalled();
  expect(await db.select().from(noteAnalyses)).toHaveLength(0);
});

test("deleting the event removes its analyses", async () => {
  await addNote("one");
  await start();
  await vi.waitFor(async () => expect((await latest()).status).toBe("done"));
  await db.delete(events).where(eq(events.id, eventId));
  expect(await db.select().from(noteAnalyses)).toHaveLength(0);
});

test("requires the AI notice once per event, then remembers it", async () => {
  await addNote("one");
  const bare = await analyze.POST(req("POST"), ctx(notesId));
  expect(bare.status).toBe(409);
  expect((await bare.json()).code).toBe("notice_required");
  const state = await (await analysis.GET(req("GET"), ctx(notesId))).json();
  expect(state.noticeAccepted).toBe(false);
  expect((await start()).status).toBe(202);
  const after = await (await analysis.GET(req("GET"), ctx(notesId))).json();
  expect(after.noticeAccepted).toBe(true);
  expect(after.approvedNoteCount).toBe(1);
  await vi.waitFor(async () =>
    expect((await latest()).status).not.toBe("queued"),
  );
  await vi.waitFor(async () =>
    expect(["done", "failed"]).toContain((await latest()).status),
  );
  expect((await analyze.POST(req("POST"), ctx(notesId))).status).toBe(202);
});

test("the owner publishes and unpublishes the latest finished analysis", async () => {
  await addNote("one");
  expect(
    (await analysis.PATCH(req("PATCH", { published: true }), ctx(notesId)))
      .status,
  ).toBe(409);
  await start();
  await vi.waitFor(async () => expect((await latest()).status).toBe("done"));

  expect(
    (
      await analysis.PATCH(
        req("PATCH", { published: true }, null),
        ctx(notesId),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await analysis.PATCH(
        req("PATCH", { published: true }, otherCookie),
        ctx(notesId),
      )
    ).status,
  ).toBe(404);
  expect(
    (await analysis.PATCH(req("PATCH", { published: "yes" }), ctx(notesId)))
      .status,
  ).toBe(400);

  const on = await analysis.PATCH(
    req("PATCH", { published: true }),
    ctx(notesId),
  );
  expect((await on.json()).analysis.published).toBe(true);
  expect((await latest()).published).toBe(true);

  // A newer run takes over: publishing it withdraws the old one.
  await start();
  await vi.waitFor(async () =>
    expect(
      (
        await db
          .select()
          .from(noteAnalyses)
          .where(eq(noteAnalyses.status, "done"))
      ).length,
    ).toBe(2),
  );
  await analysis.PATCH(req("PATCH", { published: true }), ctx(notesId));
  expect(
    await db
      .select()
      .from(noteAnalyses)
      .where(eq(noteAnalyses.published, true)),
  ).toHaveLength(1);

  const off = await analysis.PATCH(
    req("PATCH", { published: false }),
    ctx(notesId),
  );
  expect((await off.json()).analysis.published).toBe(false);
  expect(
    await db
      .select()
      .from(noteAnalyses)
      .where(eq(noteAnalyses.published, true)),
  ).toHaveLength(0);
});

const edit = (body: unknown, c: string | null = hostCookie) => analysis.PATCH(req("PATCH", body, c), ctx(notesId));

async function doneWithCategories() {
  const a = await addNote("one");
  const b = await addNote("two");
  const c = await addNote("three");
  lib.setAnalysisRunner(async () => ({
    ...output,
    categories: [
      { name: "Fast", description: "", noteIds: [a, b] },
      { name: "Slow", description: "", noteIds: [c] },
    ],
  }));
  await start();
  await vi.waitFor(async () => {
    const [row] = await db.select().from(noteAnalyses);
    expect(row.status).toBe("done");
  });
  const [row] = await db.select().from(noteAnalyses);
  return { a, b, c, id: row.id };
}
const cats = async () => {
  const [row] = await db.select().from(noteAnalyses);
  return row.categories as { name: string; noteIds: string[] }[];
};

test("editing needs the owner and a valid edit, and does not touch a run without edits", async () => {
  await doneWithCategories();
  expect((await edit({ op: "setSummary", summary: "x" }, otherCookie)).status).toBe(404);
  expect((await edit({ op: "nope" })).status).toBe(400);
  expect((await edit({ op: "setSummary", summary: "  " })).status).toBe(400);
  const [row] = await db.select().from(noteAnalyses);
  expect(row.edited).toBe(false);
});

test("rename, summary and keyword edits persist and set edited", async () => {
  await doneWithCategories();
  expect((await edit({ op: "renameCategory", name: "Fast", to: "Quick" })).status).toBe(200);
  expect((await edit({ op: "renameCategory", name: "Slow", to: "quick" })).status).toBe(400);
  expect((await edit({ op: "setSummary", summary: "Better words" })).status).toBe(200);
  expect((await edit({ op: "removeKeyword", word: "w" })).status).toBe(200);
  const [row] = await db.select().from(noteAnalyses);
  expect(row.edited).toBe(true);
  expect(row.summary).toBe("Better words");
  expect(row.keywords).toEqual([]);
  expect((await cats()).map((x) => x.name)).toEqual(["Quick", "Slow"]);
  const got = (await (await analysis.GET(req("GET"), ctx(notesId))).json()).lastDone;
  expect(got.summary).toBe("Better words");
  expect(got.edited).toBe(true);
});

test("merge moves every note into the target", async () => {
  const { a, b, c } = await doneWithCategories();
  expect((await edit({ op: "mergeCategories", from: "Slow", into: "Fast" })).status).toBe(200);
  expect(await cats()).toEqual([{ name: "Fast", description: "", noteIds: [a, b, c] }]);
  expect((await edit({ op: "mergeCategories", from: "Fast", into: "Fast" })).status).toBe(400);
});

test("move puts a note in one category only and drops emptied ones", async () => {
  const { a, b, c } = await doneWithCategories();
  expect((await edit({ op: "moveNote", noteId: c, to: "Fast" })).status).toBe(200);
  expect(await cats()).toEqual([{ name: "Fast", description: "", noteIds: [a, b, c] }]);
  expect((await edit({ op: "moveNote", noteId: a, to: "Missing" })).status).toBe(400);
  expect((await edit({ op: "moveNote", noteId: "00000000-0000-4000-8000-000000000000", to: "Fast" })).status).toBe(400);
});

test("deleting a category keeps its notes as Uncategorized", async () => {
  const { a, b, c } = await doneWithCategories();
  expect((await edit({ op: "deleteCategory", name: "Fast" })).status).toBe(200);
  expect(await cats()).toEqual([
    { name: "Slow", description: "", noteIds: [c] },
    { name: "Uncategorized", description: "", noteIds: [a, b] },
  ]);
  expect((await edit({ op: "deleteCategory", name: "Uncategorized" })).status).toBe(400);
  expect((await edit({ op: "deleteCategory", name: "Slow" })).status).toBe(200);
  const all = (await cats()).flatMap((x) => x.noteIds).sort();
  expect(all).toEqual([a, b, c].sort());
});
