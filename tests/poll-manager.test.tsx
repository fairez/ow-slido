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

  it("enforces 2-10 options", () => {
    render(<PollManager eventId="e" initialInteractions={[]} />);
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
    vi.stubGlobal("confirm", () => true);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? Response.json({ ok: true }) : Response.json({ interaction: poll("3", "Copy") }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[poll("1", "Orig")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText("Copy");
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    await waitFor(() => expect(screen.queryByText("Orig")).toBeNull());
  });
});
