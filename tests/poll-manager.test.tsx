import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PollManager, type InteractionItem } from "@/components/poll-manager";

const poll = (id: string, title: string, state: InteractionItem["state"] = "draft"): InteractionItem => ({
  id,
  type: "poll",
  title,
  state,
  position: 0,
  config: { options: [{ id: "o1", label: "A" }, { id: "o2", label: "B" }], multiSelect: false, showResultsToParticipants: false },
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PollManager", () => {
  it("lists interactions with their state and hides draft actions otherwise", () => {
    render(<PollManager eventId="e" initialInteractions={[poll("1", "Draft Q"), poll("2", "Live Q", "live")]} />);
    expect(screen.getAllByTestId("state").map((s) => s.textContent)).toEqual(["draft", "live"]);
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
  });

  it("labels a Q&A interaction and offers the same draft actions as other types", () => {
    const qa: InteractionItem = { id: "q", type: "qa", title: "Q&A", state: "draft", position: 0, config: { prompt: "Ask a question", moderation: "open" } };
    render(<PollManager eventId="e" initialInteractions={[qa]} />);
    expect(screen.getByText(/^Q&A$/, { selector: ".type-tag" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  });

  it("adds a Q&A with its name, prompt, moderation and the event's default mode", async () => {
    const created: InteractionItem = { id: "q2", type: "qa", title: "Town hall", state: "draft", position: 1, config: { prompt: "Ask us", moderation: "moderated" } };
    const fetchMock = vi.fn(async () => Response.json({ interaction: created }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[]} defaultModeration="moderated" />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    fireEvent.click(screen.getByRole("button", { name: "New Q&A" }));
    expect((screen.getByLabelText(/Moderated: questions wait/) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Town hall" } });
    fireEvent.change(screen.getByLabelText("Prompt shown above the ask box"), { target: { value: "Ask us" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Q&A" }));
    await waitFor(() => expect(screen.getByText("Town hall")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/events/e/interactions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ type: "qa", title: "Town hall", prompt: "Ask us", moderation: "moderated", profanityFilter: true }),
      }),
    );
  });

  it("edits a draft Q&A through PATCH", async () => {
    const qa: InteractionItem = { id: "q", type: "qa", title: "Q&A", state: "draft", position: 0, config: { prompt: "Ask a question", moderation: "open", profanityFilter: false } };
    const fetchMock = vi.fn(async () => Response.json({ interaction: { ...qa, title: "Renamed" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[qa]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Block profane questions") as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Q&A" }));
    await waitFor(() => expect(screen.getByText("Renamed")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/events/e/interactions/q", expect.objectContaining({ method: "PATCH" }));
  });

  it("enforces 2-10 options", () => {
    render(<PollManager eventId="e" initialInteractions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    fireEvent.click(screen.getByRole("button", { name: "New poll" }));
    expect((screen.getByRole("button", { name: "Remove option 1" }) as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    expect(screen.getAllByLabelText(/^Option \d+$/)).toHaveLength(10);
    expect((screen.getByRole("button", { name: "Add option" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates a poll with the toggles", async () => {
    const fetchMock = vi.fn(async () => Response.json({ interaction: poll("n", "Fav?") }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    fireEvent.click(screen.getByRole("button", { name: "New poll" }));
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Fav?" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "B" } });
    fireEvent.click(screen.getByLabelText(/multiple selections/));
    fireEvent.click(screen.getByRole("button", { name: "Save poll" }));
    await screen.findByText("Fav?");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/events/e/interactions");
    expect(JSON.parse(init.body as string)).toMatchObject({ question: "Fav?", multiSelect: true, showResultsToParticipants: false });
  });

  it("reorders by posting the full id list", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[poll("1", "First"), poll("2", "Second")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Second up" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")[0].textContent).toContain("Second"));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/events/e/interactions/reorder");
    expect(JSON.parse(init.body as string)).toEqual({ ids: ["2", "1"] });
  });

  it("duplicates and deletes drafts", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? Response.json({ ok: true }) : Response.json({ interaction: poll("3", "Copy") }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[poll("1", "Orig")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText("Copy");
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Delete interaction" }));
    await waitFor(() => expect(screen.queryByText("Orig")).toBeNull());
  });

  it("starting a draft pauses the live one; paused can resume or close, live can pause", async () => {
    const next = (url: string) => (url.endsWith("/start") ? "live" : url.endsWith("/pause") ? "paused" : "closed");
    const fetchMock = vi.fn(async (url: string) => Response.json({ interaction: poll("1", "Draft Q", next(url)) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[poll("1", "Draft Q"), poll("2", "Live Q", "live")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("state").map((s) => s.textContent)).toEqual(["live", "paused"]),
    );
    expect(fetchMock.mock.calls[0][0]).toBe("/api/events/e/interactions/1/start");
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("state").map((s) => s.textContent)).toEqual(["paused", "paused"]),
    );
    expect(fetchMock.mock.calls[1][0]).toBe("/api/events/e/interactions/1/pause");

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() =>
      expect(screen.getAllByTestId("state").map((s) => s.textContent)).toEqual(["closed", "paused"]),
    );
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("creates a word cloud with the entries limit", async () => {
    const created: InteractionItem = { id: "w", type: "wordcloud", title: "Mood?", state: "draft", position: 0, config: { prompt: "Mood?", maxEntriesPerParticipant: 5 } };
    const fetchMock = vi.fn(async () => Response.json({ interaction: created }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    fireEvent.click(screen.getByRole("button", { name: "New word cloud" }));
    const entries = screen.getByLabelText("Entries per participant") as HTMLInputElement;
    expect([entries.min, entries.max]).toEqual(["1", "5"]);
    expect(screen.queryByLabelText("Option 1")).toBeNull();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Mood?" } });
    fireEvent.change(entries, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save word cloud" }));
    await waitFor(() => expect(screen.getByText("Mood?")).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/events/e/interactions");
    expect(JSON.parse(init.body as string)).toEqual({ type: "wordcloud", prompt: "Mood?", maxEntriesPerParticipant: 5 });
  });
});

describe("PollManager content list", () => {
  const closedPoll = { ...poll("c", "Closed Q", "closed"), position: 2 };

  it("shows a type icon with the type name, the state and the response count", () => {
    const { container } = render(
      <PollManager eventId="e" initialInteractions={[poll("1", "One"), poll("2", "Two", "live")]} initialCounts={{ "1": 1, "2": 12 }} />,
    );
    expect(container.querySelectorAll(".interaction-row svg.type-icon[aria-hidden='true']").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByTestId("count").map((c) => c.textContent)).toEqual(["1 response", "12 responses"]);
    expect(screen.getAllByText("Poll", { selector: ".type-tag" })).toHaveLength(2);
  });

  it("offers reorder and duplicate on a started row, rename and delete only on a draft", () => {
    render(<PollManager eventId="e" initialInteractions={[poll("1", "Draft Q"), closedPoll]} />);
    expect(screen.getByRole("button", { name: "Move Closed Q up" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Duplicate" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Rename" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
  });

  it("moves a row down with the button and posts the new order", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[poll("1", "First"), poll("2", "Second", "paused")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Move First down" }));
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Second", "First"]));
    expect(fetchMock).toHaveBeenCalledWith("/api/events/e/interactions/reorder", expect.objectContaining({ body: JSON.stringify({ ids: ["2", "1"] }) }));
  });

  it("reorders by dragging a row onto another", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<PollManager eventId="e" initialInteractions={[poll("1", "First"), poll("2", "Second"), poll("3", "Third")]} />);
    const handles = container.querySelectorAll(".drag-handle");
    const rows = container.querySelectorAll(".interaction-row");
    const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(handles[0], { dataTransfer });
    fireEvent.dragOver(rows[2], { dataTransfer });
    fireEvent.drop(rows[2], { dataTransfer });
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Second", "Third", "First"]));
    expect(fetchMock).toHaveBeenCalledWith("/api/events/e/interactions/reorder", expect.objectContaining({ body: JSON.stringify({ ids: ["2", "3", "1"] }) }));
  });

  it("renames a draft in place through the type's own field", async () => {
    const fetchMock = vi.fn(async () => Response.json({ interaction: poll("1", "Better name") }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[poll("1", "Old name")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Better name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Better name"));
    expect(fetchMock).toHaveBeenCalledWith("/api/events/e/interactions/1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ question: "Better name" }) }));
  });

  it("lists every type in the Add content menu, with locked ones pointing at the plan", () => {
    render(<PollManager eventId="e" initialInteractions={[]} lockedTypes={{ rating: { requiredPlan: "pro" } }} />);
    expect(screen.queryByRole("button", { name: "New poll" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Add content" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("listitem").map((li) => li.textContent?.trim());
    expect(items).toEqual(["New poll", "New word cloud", "New shared notes", "New open text", "New rating Pro plan", "New Q&A"]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "New poll" })).toBeNull();
  });
});
