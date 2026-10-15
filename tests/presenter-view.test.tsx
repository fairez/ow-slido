import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
vi.mock("@/lib/realtime/use-event-socket", () => ({
  useEventSocket: () => ({ socket: fake, status: "connected" }),
}));

import { PresenterView } from "@/components/presenter-view";

const state = (counts: Record<string, number>, total: number) => ({
  id: "i1",
  title: "Lunch?",
  options: [
    { id: "a", label: "Pizza" },
    { id: "b", label: "Tacos" },
  ],
  counts,
  total,
});

beforeEach(() => fake.removeAllListeners());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows 'No live interaction' when nothing is live", () => {
  render(<PresenterView eventId="e1" initial={null} />);
  expect(screen.getByText("No live interaction")).toBeTruthy();
});

it("shows labels, counts, percents and total", () => {
  render(<PresenterView eventId="e1" initial={state({ a: 3, b: 1 }, 4)} />);
  expect(screen.getByText("3 (75%)")).toBeTruthy();
  expect(screen.getByText("1 (25%)")).toBeTruthy();
  expect(screen.getByText("Total votes: 4")).toBeTruthy();
});

it("updates live from poll:counts", () => {
  render(<PresenterView eventId="e1" initial={state({ a: 0, b: 0 }, 0)} />);
  expect(screen.getAllByText("0 (0%)").length).toBe(2);
  act(() => {
    fake.emit("poll:counts", { interactionId: "i1", counts: { a: 1, b: 1 }, total: 2 });
  });
  expect(screen.getAllByText("1 (50%)").length).toBe(2);
  expect(screen.getByText("Total votes: 2")).toBeTruthy();
});

it("resyncs on state-changed and shows the empty state when the poll closes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ interaction: null }))));
  render(<PresenterView eventId="e1" initial={state({ a: 1, b: 0 }, 1)} />);
  act(() => {
    fake.emit("state-changed", { interactionId: "i1", state: "closed" });
  });
  await waitFor(() => expect(screen.getByText("No live interaction")).toBeTruthy());
});
