import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventManager, type EventSummary } from "@/components/event-manager";

const ev = (id: string, name: string, startsAt: string, joinCode = "123456"): EventSummary => ({
  id,
  name,
  startsAt,
  endsAt: "2030-01-02T00:00:00.000Z",
  joinCode,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EventManager", () => {
  it("lists events sorted by start date", () => {
    render(
      <EventManager
        initialEvents={[ev("b", "Later", "2030-02-01T00:00:00.000Z"), ev("a", "Sooner", "2030-01-01T00:00:00.000Z")]}
      />,
    );
    const names = screen.getAllByRole("listitem").map((li) => li.querySelector("strong")?.textContent);
    expect(names).toEqual(["Sooner", "Later"]);
  });

  it("shows the join code and URL after creating", async () => {
    const saved = ev("n", "New", "2030-01-01T00:00:00.000Z", "654321");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ event: saved }, { status: 201 })));
    render(<EventManager initialEvents={[]} />);
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2030-01-01T10:00" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2030-01-01T12:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("654321");
    expect(status.textContent).toContain("/join/654321");
  });

  it("renames an event", async () => {
    const original = ev("a", "Old", "2030-01-01T00:00:00.000Z");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ event: { ...original, name: "Renamed" } })));
    render(<EventManager initialEvents={[original]} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Renamed")).toBeTruthy();
  });

  it("duplicates an event and lists the copy", async () => {
    const original = ev("a", "Town hall", "2030-01-01T00:00:00.000Z");
    const copy = ev("b", "Town hall (copy)", "2030-01-01T00:00:00.000Z", "654321");
    const fetchMock = vi.fn(async () => Response.json({ event: copy }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<EventManager initialEvents={[original]} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect((await screen.findAllByText("Town hall (copy)")).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith("/api/events/a/duplicate", { method: "POST" });
  });

  it("deletes only after confirmation", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<EventManager initialEvents={[ev("a", "Doomed", "2030-01-01T00:00:00.000Z")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete event" }));
    await waitFor(() => expect(screen.queryByText("Doomed")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
