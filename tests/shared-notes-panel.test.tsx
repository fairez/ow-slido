import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };

import { SharedNotesPanel } from "@/components/shared-notes-panel";
import type { LiveNotes } from "@/lib/live-view";

const config = (extra: Partial<LiveNotes> = {}): LiveNotes => ({
  id: "n1",
  type: "sharedNotes",
  title: "Thoughts?",
  state: "live",
  maxNotes: 2,
  remaining: 2,
  moderation: "open",
  showAuthorNames: false,
  aiDisclosure: false,
  ...extra,
});

const note = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  interactionId: "n1",
  text,
  authorName: null,
  pinned: false,
  createdAt: "2026-10-16T10:00:00.000Z",
  upvotes: 0,
  mine: false,
  iUpvoted: false,
  ...extra,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const renderPanel = (c: LiveNotes) => render(<SharedNotesPanel notes={c} socket={fake as never} />);

beforeEach(() => fake.removeAllListeners());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lists notes with upvote buttons, and edit/delete on your own", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ notes: [note("a", "Their note", { upvotes: 2 }), note("b", "My note", { mine: true })] })));
  renderPanel(config());
  expect(await screen.findByRole("button", { name: "Upvote: Their note" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit your note: My note" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete your note: My note" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Upvote: My note" })).toBeNull();
});

it("shows the character counter, remaining count and the name field only when enabled", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ notes: [] })));
  const { unmount } = renderPanel(config());
  expect(screen.getByText("0/500")).toBeTruthy();
  expect(screen.getByText("2 notes remaining")).toBeTruthy();
  expect(screen.queryByLabelText("Your name (optional)")).toBeNull();
  fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "hello" } });
  expect(screen.getByText("5/500")).toBeTruthy();
  unmount();
  renderPanel(config({ showAuthorNames: true }));
  expect(screen.getByLabelText("Your name (optional)")).toBeTruthy();
});

it("posts a note, sends the name, and counts down", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? json({ note: { id: "x", text: "hello", authorName: "Sam", status: "approved", pinned: false, createdAt: "2026-10-16T10:00:00.000Z" } }, 201)
      : json({ notes: [] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  renderPanel(config({ showAuthorNames: true }));
  fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "hello" } });
  fireEvent.change(screen.getByLabelText("Your name (optional)"), { target: { value: "Sam" } });
  fireEvent.click(screen.getByRole("button", { name: "Send note" }));
  expect(await screen.findByText("1 note remaining")).toBeTruthy();
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(post[1]!.body as string)).toEqual({ text: "hello", authorName: "Sam" });
  expect(screen.getByRole("button", { name: "Edit your note: hello" })).toBeTruthy();
});

it("tells the participant a moderated note is waiting for approval", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ note: { id: "x", text: "hello", authorName: null, status: "pending", pinned: false, createdAt: "2026-10-16T10:00:00.000Z" } }, 201)
        : json({ notes: [] }),
    ),
  );
  renderPanel(config({ moderation: "moderated" }));
  fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send note" }));
  expect((await screen.findByText(/waiting for approval/)).textContent).toContain("waiting for approval");
  expect(screen.queryByRole("button", { name: /Edit your note/ })).toBeNull();
});

it("disables the form when every note is used", () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ notes: [] })));
  renderPanel(config({ remaining: 0 }));
  expect(screen.getByText("You have used all your notes.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Send note" }) as HTMLButtonElement).disabled).toBe(true);
});

it("toggles an upvote with the server's count", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ upvoted: true, upvotes: 3 }) : json({ notes: [note("a", "Their note", { upvotes: 2 })] }),
    ),
  );
  renderPanel(config());
  const button = await screen.findByRole("button", { name: "Upvote: Their note" });
  fireEvent.click(button);
  await waitFor(() => expect(button.textContent).toContain("3"));
  expect(button.getAttribute("aria-pressed")).toBe("true");
});

it("edits and deletes your own note", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return json({ note: { text: "Better", status: "approved" } });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return json({ notes: [note("b", "My note", { mine: true })] });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderPanel(config());
  fireEvent.click(await screen.findByRole("button", { name: "Edit your note: My note" }));
  fireEvent.change(screen.getByLabelText("Edit your note"), { target: { value: "Better" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Better")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete your note: Better" }));
  await waitFor(() => expect(screen.queryByText("Better")).toBeNull());
  expect(screen.getByText("2 notes remaining")).toBeTruthy();
});

it("updates live: added, votes, removed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ notes: [] })));
  renderPanel(config());
  await waitFor(() => expect(fake.listenerCount("note:added")).toBe(1));
  act(() => {
    fake.emit("note:added", { note: { ...note("z", "Live one"), mine: undefined, iUpvoted: undefined } });
  });
  expect(screen.getByText("Live one")).toBeTruthy();
  act(() => {
    fake.emit("note:votes", { interactionId: "n1", noteId: "z", upvotes: 4 });
  });
  expect(screen.getByRole("button", { name: "Upvote: Live one" }).textContent).toContain("4");
  act(() => {
    fake.emit("note:removed", { interactionId: "n1", noteId: "z" });
  });
  expect(screen.queryByText("Live one")).toBeNull();
});

it("hides the form and own edit actions when closed, but keeps upvoting", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ notes: [note("a", "Their note"), note("b", "My note", { mine: true })] })));
  renderPanel(config({ state: "closed" }));
  expect(await screen.findByRole("button", { name: "Upvote: Their note" })).toBeTruthy();
  expect(screen.queryByLabelText("Your note")).toBeNull();
  expect(screen.queryByRole("button", { name: /Edit your note/ })).toBeNull();
  expect(screen.getByText(/Notes are closed/)).toBeTruthy();
});

it("discloses AI processing only when AI is configured", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ notes: [] })));
  const { unmount } = renderPanel(config());
  expect(screen.queryByText(/AI service/)).toBeNull();
  unmount();
  renderPanel(config({ aiDisclosure: true }));
  expect(screen.getByText(/AI service summarise these notes/)).toBeTruthy();
});

it("shows a published analysis, and removes it when the host withdraws it", async () => {
  const analysis = {
    summary: "People want shorter talks.",
    categories: [{ name: "Length", description: "", count: 2 }],
    keywords: [{ word: "short", weight: 3 }],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/analysis/published") ? json({ analysis }) : json({ notes: [] }))));
  renderPanel(config());
  expect(await screen.findByText("People want shorter talks.")).toBeTruthy();
  expect(screen.getByText("Length")).toBeTruthy();
  act(() => {
    fake.emit("analysis:published", { interactionId: "n1", analysis: null });
  });
  await waitFor(() => expect(screen.queryByText("People want shorter talks.")).toBeNull());
});
