import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
vi.mock("@/lib/realtime/use-event-socket", () => ({
  useEventSocket: () => ({ socket: fake, status: "connected" }),
}));

import { PresenterView } from "@/components/presenter-view";

const state = (counts: Record<string, number>, total: number) => ({
  type: "poll" as const,
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
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={null} />);
  expect(screen.getByText("No live interaction")).toBeTruthy();
});

it("shows labels, counts, percents and total", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={state({ a: 3, b: 1 }, 4)} />);
  expect(screen.getByText("3 (75%)")).toBeTruthy();
  expect(screen.getByText("1 (25%)")).toBeTruthy();
  expect(screen.getByText("Total votes: 4")).toBeTruthy();
});

it("updates live from poll:counts", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={state({ a: 0, b: 0 }, 0)} />);
  expect(screen.getAllByText("0 (0%)").length).toBe(2);
  act(() => {
    fake.emit("poll:counts", { interactionId: "i1", counts: { a: 1, b: 1 }, total: 2 });
  });
  expect(screen.getAllByText("1 (50%)").length).toBe(2);
  expect(screen.getByText("Total votes: 2")).toBeTruthy();
});

it("resyncs on state-changed and shows the empty state when the poll closes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ interaction: null }))));
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={state({ a: 1, b: 0 }, 1)} />);
  act(() => {
    fake.emit("state-changed", { interactionId: "i1", state: "closed" });
  });
  await waitFor(() => expect(screen.getByText("No live interaction")).toBeTruthy());
});

it("shows the join code and a QR image", async () => {
  render(<PresenterView eventId="e1" initial={null} joinCode="123456" items={[]} />);
  expect(screen.getByText("Join code: 123456")).toBeTruthy();
  await waitFor(() => expect(screen.getByAltText(/QR code to join/)).toBeTruthy());
});

it("ArrowRight starts the next draft interaction", async () => {
  const fetchMock = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  const items = [
    { id: "i1", state: "live" as const },
    { id: "i2", state: "draft" as const },
  ];
  render(<PresenterView eventId="e1" initial={state({}, 0)} joinCode="1234" items={items} />);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  });
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/events/e1/interactions/i2/start", { method: "POST" }),
  );
});

const cloud = (words: { word: string; count: number }[]) => ({
  type: "wordcloud" as const,
  id: "w1",
  title: "One word for today",
  words,
  total: words.reduce((n, w) => n + w.count, 0),
});

it("renders a word cloud with sizes by frequency, a text list and a count on focus", () => {
  render(
    <PresenterView
      eventId="e1"
      joinCode="1234"
      items={[]}
      initial={cloud([
        { word: "great", count: 5 },
        { word: "ok", count: 1 },
      ])}
    />,
  );
  const big = screen.getByRole("listitem", { name: "great, 5 entries" });
  const small = screen.getByRole("listitem", { name: "ok, 1 entry" });
  expect(parseFloat(big.style.fontSize)).toBeGreaterThan(parseFloat(small.style.fontSize));
  expect(screen.getByText("great: 5")).toBeTruthy();
  expect(screen.queryByText("×5")).toBeNull();
  act(() => big.focus());
  expect(screen.getByText("×5")).toBeTruthy();
  expect(screen.getByText("Total words: 6")).toBeTruthy();
});

it("updates the word cloud live from wordcloud:words", () => {
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={cloud([])} />);
  expect(screen.getByText("No words yet")).toBeTruthy();
  act(() => {
    fake.emit("wordcloud:words", { interactionId: "w1", words: [{ word: "hello", count: 2 }], total: 2 });
  });
  expect(screen.getByText("hello: 2")).toBeTruthy();
});
