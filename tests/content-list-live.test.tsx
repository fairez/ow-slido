import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PollManager, type InteractionItem } from "@/components/poll-manager";

type Handler = () => void;
const handlers = new Map<string, Set<Handler>>();
const fakeSocket = {
  on: (name: string, fn: Handler) => void (handlers.get(name) ?? handlers.set(name, new Set()).get(name)!).add(fn),
  off: (name: string, fn: Handler) => void handlers.get(name)?.delete(fn),
};
vi.mock("@/lib/realtime/use-event-socket", () => ({ useEventSocket: () => ({ socket: fakeSocket, status: "connected" }) }));

const item = (id: string, title: string, state: InteractionItem["state"] = "draft"): InteractionItem => ({
  id,
  type: "openText",
  title,
  state,
  position: 0,
  config: { prompt: title, maxResponsesPerParticipant: 1 },
});
const emit = (name: string) => act(() => handlers.get(name)?.forEach((fn) => fn()));

afterEach(() => {
  cleanup();
  handlers.clear();
  vi.unstubAllGlobals();
});

describe("content list over the socket", () => {
  it("reloads the list and counts when another member changes the content", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ interactions: [item("1", "One"), item("2", "Added elsewhere")], counts: { "2": 3 } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[item("1", "One")]} liveUpdates />);
    emit("content:changed");
    await waitFor(() => expect(screen.getByText("Added elsewhere")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/events/e/interactions");
    expect(screen.getAllByTestId("count").map((c) => c.textContent)).toEqual(["0 responses", "3 responses"]);
  });

  it("coalesces a burst of messages into one reload and refreshes counts on new responses", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => Response.json({ interactions: [item("1", "One", "live")], counts: { "1": 40 } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PollManager eventId="e" initialInteractions={[item("1", "One", "live")]} liveUpdates />);
    for (let i = 0; i < 5; i++) emit("response:added");
    emit("state-changed");
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("40 responses"));
    // The live open-text row also fetches its own panel; count only reloads of the list.
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/events/e/interactions")).toHaveLength(1);
  });

  it("does not listen when live updates are off", () => {
    render(<PollManager eventId="e" initialInteractions={[item("1", "One")]} />);
    expect(handlers.get("content:changed")?.size ?? 0).toBe(0);
  });
});
