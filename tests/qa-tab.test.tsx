import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
vi.mock("@/lib/realtime/use-event-socket", () => ({
  useEventSocket: () => ({ socket: fake, status: "connected" }),
}));

import { QaTab } from "@/components/qa-tab";

const q = (id: string, text: string, extra = {}) => ({
  id,
  text,
  authorName: null,
  answered: false,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  upvotes: 0,
  upvoted: false,
  ...extra,
});

beforeEach(() => fake.removeAllListeners());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lists approved questions and shows a character counter", () => {
  render(<QaTab eventId="e1" initial={[q("1", "Why?", { authorName: "Sam" })]} />);
  expect(screen.getByText("Why?")).toBeTruthy();
  expect(screen.getByText(/Sam/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "hello" } });
  expect(screen.getByText("5/300")).toBeTruthy();
});

it("shows the approval notice after submitting in a moderated event", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, status: "pending", question: q("2", "Hi") }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QaTab eventId="e1" initial={[]} />);
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Hi" } });
  fireEvent.change(screen.getByLabelText("Your name (optional)"), { target: { value: "Ann" } });
  fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  expect(await screen.findByText("Your question is waiting for approval")).toBeTruthy();
  expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ text: "Hi", authorName: "Ann" });
  expect(screen.queryByText("Hi")).toBeNull();
});

it("adds approved questions live without duplicates", async () => {
  render(<QaTab eventId="e1" initial={[]} />);
  act(() => {
    fake.emit("question:added", { question: q("3", "Live one") });
    fake.emit("question:added", { question: q("3", "Live one") });
  });
  await waitFor(() => expect(screen.getAllByText("Live one")).toHaveLength(1));
});

it("shows server errors", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "That question contains language we can't accept" }), { status: 400 })));
  render(<QaTab eventId="e1" initial={[]} />);
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  expect((await screen.findByRole("alert")).textContent).toContain("language we can't accept");
});

it("toggles an upvote and shows the new count", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, upvoted: true, upvotes: 4 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QaTab eventId="e1" initial={[q("1", "Why?", { upvotes: 3 })]} />);
  const button = screen.getByRole("button", { name: "Upvote: Why?" });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(button);
  await waitFor(() => expect(button.textContent).toContain("4"));
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/questions/1/upvote");
});

it("updates counts live and sorts by Popular or Recent", async () => {
  render(
    <QaTab
      eventId="e1"
      initial={[
        q("1", "Newer", { createdAt: "2026-01-02T00:00:00.000Z" }),
        q("2", "Older", { createdAt: "2026-01-01T00:00:00.000Z" }),
      ]}
    />,
  );
  const order = () => screen.getAllByRole("listitem").map((li) => li.textContent?.includes("Newer") ? "Newer" : "Older");
  expect(order()).toEqual(["Newer", "Older"]);
  act(() => void fake.emit("question:votes", { questionId: "2", upvotes: 5 }));
  expect(order()).toEqual(["Newer", "Older"]);
  fireEvent.click(screen.getByRole("button", { name: "Popular" }));
  expect(order()).toEqual(["Older", "Newer"]);
  fireEvent.click(screen.getByRole("button", { name: "Recent" }));
  expect(order()).toEqual(["Newer", "Older"]);
});

it("applies host pin/answered updates and removals live", () => {
  render(<QaTab eventId="e1" initial={[q("1", "Older", { createdAt: "2026-01-01T00:00:00.000Z" }), q("2", "Newer", { createdAt: "2026-02-01T00:00:00.000Z" })]} />);
  act(() => void fake.emit("question:updated", { questionId: "1", pinned: true, answered: true }));
  const items = screen.getAllByRole("listitem");
  expect(items[0].textContent).toContain("Older");
  expect(items[0].textContent).toContain("Answered");
  act(() => void fake.emit("question:removed", { questionId: "1" }));
  expect(screen.queryByText("Older")).toBeNull();
});
