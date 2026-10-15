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
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Please keep questions respectful" }), { status: 400 })));
  render(<QaTab eventId="e1" initial={[]} />);
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  expect((await screen.findByRole("alert")).textContent).toContain("respectful");
});
