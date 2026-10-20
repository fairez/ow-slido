import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventManager, type EventSummary } from "@/components/event-manager";
import { RetentionSettings } from "@/components/retention-settings";
import { deletionDate, deletionIsNear, formatDeletionDay } from "@/lib/retention-schedule";

vi.mock("@/components/live-participant-count", () => ({ LiveParticipantCount: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const DAY = 24 * 60 * 60 * 1000;

describe("deletionDate", () => {
  const now = new Date("2026-10-21T10:00:00Z");
  const endsAt = new Date("2026-10-01T10:00:00Z");

  it("is null when everything is kept", () => {
    expect(deletionDate({ endsAt, retentionDays: null, noticeSentAt: null, now })).toBeNull();
  });

  it("is the end of the period when it is far enough away", () => {
    const date = deletionDate({ endsAt, retentionDays: 90, noticeSentAt: null, now }) as Date;
    expect(formatDeletionDay(date)).toBe("2026-12-30");
    expect(deletionIsNear(date, now)).toBe(false);
  });

  it("waits a full notice period after a warning that came late", () => {
    const old = new Date("2026-09-01T10:00:00Z");
    const unwarned = deletionDate({ endsAt: old, retentionDays: 30, noticeSentAt: null, now }) as Date;
    expect(formatDeletionDay(unwarned)).toBe("2026-10-28");
    const warned = deletionDate({ endsAt: old, retentionDays: 30, noticeSentAt: new Date(now.getTime() - 3 * DAY), now }) as Date;
    expect(formatDeletionDay(warned)).toBe("2026-10-25");
    expect(deletionIsNear(warned, now)).toBe(true);
  });
});

describe("EventManager deletion badge", () => {
  const ev = (id: string, endsAt: string): EventSummary => ({
    id,
    name: `Event ${id}`,
    startsAt: "2030-01-01T00:00:00.000Z",
    endsAt,
    joinCode: "123456",
    audienceLocale: "en",
  });

  it("shows the delete date on each event once retention is set", () => {
    render(<EventManager initialEvents={[ev("a", "2031-01-01T00:00:00.000Z")]} retentionDays={30} />);
    expect(screen.getByText("Deletes 2031-01-31")).toBeTruthy();
  });

  it("shows nothing when events are kept", () => {
    render(<EventManager initialEvents={[ev("a", "2031-01-01T00:00:00.000Z")]} />);
    expect(screen.queryByText(/^Deletes /)).toBeNull();
  });

  it("marks an event that is already due with the accent tone", () => {
    const due = ev("a", "2020-01-01T00:00:00.000Z");
    render(<EventManager initialEvents={[due, ev("b", "2031-01-01T00:00:00.000Z")]} retentionDays={30} />);
    const badges = [...document.querySelectorAll(".ui-badge")].filter((b) => b.textContent?.startsWith("Deletes"));
    expect(badges.map((b) => b.getAttribute("data-tone"))).toEqual(["accent", "neutral"]);
  });
});

describe("RetentionSettings", () => {
  it("offers 30, 90, 365 days and Keep, with the saved one selected", () => {
    render(<RetentionSettings initial={90} />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(4);
    expect(radios.map((r) => r.checked)).toEqual([false, true, false, false]);
    expect(screen.getByRole("group", { name: "Delete events" })).toBeTruthy();
  });

  it("explains what the chosen period removes", () => {
    render(<RetentionSettings initial={null} />);
    expect(screen.getByTestId("retention-effect").textContent).toBe("Nothing is deleted automatically.");
    fireEvent.click(screen.getByRole("radio", { name: "30 days after the event ends" }));
    expect(screen.getByTestId("retention-effect").textContent).toContain("deleted 30 days after they end");
  });

  it("saves the choice and confirms", async () => {
    const fetchMock = vi.fn(async () => Response.json({ retentionDays: 365 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RetentionSettings initial={null} />);
    fireEvent.click(screen.getByRole("radio", { name: "365 days after the event ends" }));
    fireEvent.click(screen.getByRole("button", { name: "Save retention" }));
    expect((await screen.findByRole("status")).textContent).toBe("Retention saved.");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/workspaces/active/retention");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ retentionDays: 365 });
  });

  it("sends null for Keep and shows the server's error", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "Not allowed." }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RetentionSettings initial={30} />);
    fireEvent.click(screen.getByRole("radio", { name: /Never/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save retention" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Not allowed."));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ retentionDays: null });
    expect(screen.queryByText("Retention saved.")).toBeNull();
  });
});
