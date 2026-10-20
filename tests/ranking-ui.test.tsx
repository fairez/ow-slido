import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RankingForm } from "@/components/ranking-form";
import type { LiveRanking } from "@/lib/live-view";

const live = (extra: Partial<LiveRanking> = {}): LiveRanking => ({
  id: "k1",
  type: "ranking",
  title: "Favourite",
  state: "live",
  prompt: "Rank these",
  options: [
    { id: "a", text: "Alpha" },
    { id: "b", text: "Beta" },
    { id: "c", text: "Gamma" },
  ],
  mine: null,
  ...extra,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const texts = () => screen.getAllByRole("listitem").map((li) => li.querySelector(".ranking-text")?.textContent);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("labels each button with the option name and position, and announces a move", () => {
  render(<RankingForm ranking={live()} />);
  fireEvent.click(screen.getByRole("button", { name: "Move Alpha down, currently position 1 of 3" }));
  expect(texts()).toEqual(["Beta", "Alpha", "Gamma"]);
  expect(screen.getByRole("status").textContent).toBe("Alpha moved to position 2 of 3");
  fireEvent.click(screen.getByRole("button", { name: "Move Gamma up, currently position 3 of 3" }));
  expect(texts()).toEqual(["Beta", "Gamma", "Alpha"]);
});

it("keeps focus on the button that was used and ignores moves past the ends", () => {
  render(<RankingForm ranking={live()} />);
  const first = screen.getByRole("button", { name: "Move Alpha up, currently position 1 of 3" });
  expect(first.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(first);
  expect(texts()).toEqual(["Alpha", "Beta", "Gamma"]);
  const down = screen.getByRole("button", { name: "Move Beta down, currently position 2 of 3" });
  down.focus();
  fireEvent.click(down);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Beta down, currently position 3 of 3" }));
});

it("reorders by dragging the handle", () => {
  render(<RankingForm ranking={live()} />);
  const rows = screen.getAllByRole("listitem");
  const box = (top: number) => ({ top, height: 40, bottom: top + 40, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) });
  rows.forEach((row, i) => (row.getBoundingClientRect = () => box(i * 50)));
  const handle = rows[0].querySelector(".ranking-handle") as HTMLElement;
  fireEvent.pointerDown(handle, { pointerId: 1, pointerType: "touch", clientY: 20 });
  fireEvent.pointerMove(window, { pointerId: 1, clientY: 130 });
  expect(texts()).toEqual(["Beta", "Gamma", "Alpha"]);
  fireEvent.pointerUp(window, { pointerId: 1 });
  // After the drop, further movement does nothing.
  fireEvent.pointerMove(window, { pointerId: 1, clientY: 0 });
  expect(texts()).toEqual(["Beta", "Gamma", "Alpha"]);
});

it("sends the order, shows 'Answer sent' and locks the list", async () => {
  const fetchMock = vi.fn(async () => json({ ok: true }, 201));
  vi.stubGlobal("fetch", fetchMock);
  render(<RankingForm ranking={live()} />);
  fireEvent.click(screen.getByRole("button", { name: "Move Gamma up, currently position 3 of 3" }));
  fireEvent.click(screen.getByRole("button", { name: "Send ranking" }));
  await waitFor(() => expect(screen.getByText("Answer sent")).toBeTruthy());
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/interactions/k1/ranking");
  expect(JSON.parse(init.body as string)).toEqual({ order: ["a", "c", "b"] });
  expect(screen.queryByRole("button", { name: /Move/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Send ranking" })).toBeNull();
});

it("shows the earlier answer in the same state after a reconnect", () => {
  render(<RankingForm ranking={live({ mine: ["c", "a", "b"] })} />);
  expect(texts()).toEqual(["Gamma", "Alpha", "Beta"]);
  expect(screen.getByText("Answer sent")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send ranking" })).toBeNull();
});

it("treats a second submit from another device as sent", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "You have already submitted a ranking" }, 409)));
  render(<RankingForm ranking={live()} />);
  fireEvent.click(screen.getByRole("button", { name: "Send ranking" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Send ranking" })).toBeNull());
});

it("shows the closed state without a form unless an answer was sent", () => {
  const { unmount } = render(<RankingForm ranking={live({ state: "closed" })} />);
  expect(screen.getByText("Ranking closed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send ranking" })).toBeNull();
  unmount();
  render(<RankingForm ranking={live({ state: "closed", mine: ["a", "b", "c"] })} />);
  expect(screen.getByText("Your answer was sent before the host closed this.")).toBeTruthy();
});
