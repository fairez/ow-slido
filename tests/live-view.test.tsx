import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
vi.mock("@/lib/realtime/use-event-socket", () => ({
  useEventSocket: () => ({ socket: fake, status: "connected" }),
}));

import { LiveView } from "@/components/live-view";

const poll = (id: string, title: string) => ({
  id,
  type: "poll" as const,
  title,
  state: "live" as const,
  options: [
    { id: "a", label: "Pizza" },
    { id: "b", label: "Tacos" },
  ],
  multiSelect: false,
});

beforeEach(() => fake.removeAllListeners());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows the waiting state when nothing is live", () => {
  render(<LiveView eventId="e1" initial={null} />);
  expect(screen.getByRole("status").textContent).toContain("Waiting for the host");
});

it("shows a live poll loaded mid-event", () => {
  render(<LiveView eventId="e1" initial={poll("i1", "Lunch?")} />);
  expect(screen.getByRole("heading", { name: "Lunch?" })).toBeTruthy();
  expect(screen.getByText("Pizza")).toBeTruthy();
  expect(screen.getByText("Tacos")).toBeTruthy();
});

it("fetches and shows a poll when the host starts it", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ interaction: poll("i1", "Lunch?") })));
  vi.stubGlobal("fetch", fetchMock);
  render(<LiveView eventId="e1" initial={null} />);
  act(() => {
    fake.emit("state-changed", { interactionId: "i1", state: "live" });
  });
  expect(await screen.findByRole("heading", { name: "Lunch?" })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/events/e1/live");
});

it("shows 'Voting closed' when the live poll closes, then the next poll when started", async () => {
  render(<LiveView eventId="e1" initial={poll("i1", "Lunch?")} />);
  act(() => {
    fake.emit("state-changed", { interactionId: "i1", state: "closed" });
  });
  expect(screen.getByText("Voting closed")).toBeTruthy();
  expect(screen.queryByText("Pizza")).toBeNull();

  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ interaction: poll("i2", "Dinner?") }))));
  act(() => {
    fake.emit("state-changed", { interactionId: "i2", state: "live" });
  });
  await waitFor(() => expect(screen.getByRole("heading", { name: "Dinner?" })).toBeTruthy());
  expect(screen.queryByText("Voting closed")).toBeNull();
});

it("resyncs on reconnect", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ interaction: poll("i1", "Lunch?") })));
  vi.stubGlobal("fetch", fetchMock);
  render(<LiveView eventId="e1" initial={null} />);
  act(() => {
    fake.emit("connect");
  });
  expect(await screen.findByRole("heading", { name: "Lunch?" })).toBeTruthy();
});
