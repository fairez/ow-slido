import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
vi.mock("@/lib/realtime/use-event-socket", () => ({
  useEventSocket: () => ({ socket: fake, status: "connected" }),
}));

import { LiveView } from "@/components/live-view";

const poll = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "poll" as const,
  title,
  state: "live" as const,
  options: [
    { id: "a", label: "Pizza" },
    { id: "b", label: "Tacos" },
  ],
  multiSelect: false,
  showResultsToParticipants: false,
  ...extra,
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

const vote = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

it("submits a vote, confirms, locks the form and hides results by default", async () => {
  const fetchMock = vote(201, { ok: true, counts: { counts: { a: 1, b: 0 }, total: 1 } });
  vi.stubGlobal("fetch", fetchMock);
  render(<LiveView eventId="e1" initial={poll("i1", "Lunch?")} />);
  expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("Tacos"));
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(await screen.findByText(/your vote was recorded/)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/interactions/i1/vote",
    expect.objectContaining({ body: JSON.stringify({ optionIds: ["b"] }) }),
  );
  expect((screen.getByLabelText("Pizza") as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  expect(screen.queryByText(/votes? so far/)).toBeNull();
});

it("shows live results after voting when the poll allows it", async () => {
  vi.stubGlobal("fetch", vote(201, { ok: true, counts: { counts: { a: 1, b: 0 }, total: 1 } }));
  render(<LiveView eventId="e1" initial={poll("i1", "Lunch?", { showResultsToParticipants: true })} />);
  fireEvent.click(screen.getByLabelText("Pizza"));
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(await screen.findByText("1 vote so far")).toBeTruthy();
  act(() => {
    fake.emit("poll:counts", { interactionId: "i1", counts: { a: 2, b: 1 }, total: 3 });
  });
  expect(screen.getByText("3 votes so far")).toBeTruthy();
});

it("uses checkboxes for multi-select polls", async () => {
  const fetchMock = vote(201, { ok: true, counts: { counts: {}, total: 1 } });
  vi.stubGlobal("fetch", fetchMock);
  render(<LiveView eventId="e1" initial={poll("i1", "Lunch?", { multiSelect: true })} />);
  fireEvent.click(screen.getByLabelText("Pizza"));
  fireEvent.click(screen.getByLabelText("Tacos"));
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  await screen.findByText(/your vote was recorded/);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/interactions/i1/vote",
    expect.objectContaining({ body: JSON.stringify({ optionIds: ["a", "b"] }) }),
  );
});

it("shows server errors and locks after 'already voted'", async () => {
  vi.stubGlobal("fetch", vote(409, { error: "You have already voted" }));
  render(<LiveView eventId="e1" initial={poll("i1", "Lunch?")} />);
  fireEvent.click(screen.getByLabelText("Pizza"));
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect((await screen.findByRole("alert")).textContent).toBe("You have already voted");
  expect((screen.getByLabelText("Pizza") as HTMLInputElement).disabled).toBe(true);
});

it("keeps the form open after a 'not open' error", async () => {
  vi.stubGlobal("fetch", vote(409, { error: "Voting is not open" }));
  render(<LiveView eventId="e1" initial={poll("i1", "Lunch?")} />);
  fireEvent.click(screen.getByLabelText("Pizza"));
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Voting is not open");
});
