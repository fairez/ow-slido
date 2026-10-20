import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
vi.mock("@/lib/realtime/use-event-socket", () => ({
  useEventSocket: () => ({ socket: fake, status: "connected" }),
}));

import { PollManager } from "@/components/poll-manager";
import { PresenterView } from "@/components/presenter-view";
import { RatingForm } from "@/components/rating-form";
import type { LiveRating } from "@/lib/live-view";
import type { RatingResults } from "@/lib/rating";

const live = (extra: Partial<LiveRating> = {}): LiveRating => ({
  id: "r1",
  type: "rating",
  title: "How was it?",
  state: "live",
  scale: "stars5",
  mine: null,
  ...extra,
});

const results = (distribution: number[], average: number | null): RatingResults => ({
  interactionId: "r1",
  scale: distribution.length === 5 ? "stars5" : "numeric10",
  total: distribution.reduce((a, b) => a + b, 0),
  average,
  distribution,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => fake.removeAllListeners());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("offers five radios for stars, sends the choice and confirms", async () => {
  const fetchMock = vi.fn(async () => json({ value: 4 }, 201));
  vi.stubGlobal("fetch", fetchMock);
  render(<RatingForm rating={live()} />);
  expect(screen.getAllByRole("radio")).toHaveLength(5);
  expect((screen.getByRole("button", { name: "Send rating" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "4 stars" }));
  fireEvent.click(screen.getByRole("button", { name: "Send rating" }));
  await waitFor(() => expect(screen.getByText("Thanks, you rated this 4 out of 5.")).toBeTruthy());
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/interactions/r1/rating");
  expect(JSON.parse(init.body as string)).toEqual({ value: 4 });
  expect(screen.getByRole("radio", { name: "1 star" }).matches(":disabled")).toBe(true);
});

it("offers ten numbers on the numeric scale", () => {
  render(<RatingForm rating={live({ scale: "numeric10" })} />);
  expect(screen.getAllByRole("radio")).toHaveLength(10);
  expect(screen.getByRole("radio", { name: "10" })).toBeTruthy();
});

it("shows an earlier rating as locked and the closed state", () => {
  const { unmount } = render(<RatingForm rating={live({ mine: 3 })} />);
  expect(screen.getByText("Thanks, you rated this 3 out of 5.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send rating" })).toBeNull();
  unmount();
  render(<RatingForm rating={live({ state: "closed" })} />);
  expect(screen.getByText("Rating closed")).toBeTruthy();
});

it("shows a server error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "This question is not open" }, 409)));
  render(<RatingForm rating={live()} />);
  fireEvent.click(screen.getByRole("radio", { name: "2 stars" }));
  fireEvent.click(screen.getByRole("button", { name: "Send rating" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("This question is not open"));
});

it("presenter prints the average to one decimal, the total and each count, and updates live", () => {
  render(
    <PresenterView
      eventId="e1"
      joinCode="ABC123"
      items={[{ id: "r1", state: "live" }]}
      initial={{ type: "rating", id: "r1", title: "How was it?", state: "live", results: results([0, 1, 0, 2, 1], 3.75) }}
    />,
  );
  expect(screen.getByText("3.8")).toBeTruthy();
  expect(screen.getByText("4 responses")).toBeTruthy();
  expect(screen.getByText("2 (50%)")).toBeTruthy();
  act(() => {
    fake.emit("rating:results", { results: results([0, 1, 0, 2, 2], 3.8) });
  });
  expect(screen.getByText("5 responses")).toBeTruthy();
  expect(screen.getByText("3.8")).toBeTruthy();
});

it("host builder creates a rating with the chosen scale", async () => {
  const fetchMock = vi.fn(async () =>
    json({ interaction: { id: "n", type: "rating", title: "Rate it", state: "draft", position: 0, config: { scale: "numeric10" } } }, 201),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<PollManager eventId="e1" initialInteractions={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Add content" }));
  fireEvent.click(screen.getByRole("button", { name: "New rating" }));
  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Rate it" } });
  fireEvent.click(screen.getByLabelText(/Numbers, 1 to 10/));
  fireEvent.click(screen.getByRole("button", { name: "Save rating" }));
  await waitFor(() => expect(screen.getByText("Rate it")).toBeTruthy());
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(init.body as string)).toEqual({ type: "rating", prompt: "Rate it", scale: "numeric10" });
});
