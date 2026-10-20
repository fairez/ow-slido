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

type Qa = import("@/lib/question-types").ParticipantQa;
const qa = (questions: ReturnType<typeof q>[], extra: Partial<Qa> = {}): Qa => ({
  id: "qa1",
  title: "Q&A",
  prompt: "Ask a question",
  state: "live",
  questions,
  ...extra,
});
const view = (questions: ReturnType<typeof q>[], extra: Partial<Qa> = {}) => ({
  current: qa(questions, extra),
  earlier: [] as Qa[],
});
const noQa = { current: null, earlier: [] as Qa[] };

beforeEach(() => fake.removeAllListeners());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lists approved questions and shows a character counter", () => {
  render(<QaTab eventId="e1" initial={view([q("1", "Why?", { authorName: "Sam" })])} />);
  expect(screen.getByText("Why?")).toBeTruthy();
  expect(screen.getByText(/Sam/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "hello" } });
  expect(screen.getByText("5/300")).toBeTruthy();
});

it("shows the approval notice after submitting in a moderated event", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, status: "pending", question: q("2", "Hi") }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QaTab eventId="e1" initial={view([])} />);
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Hi" } });
  fireEvent.change(screen.getByLabelText("Your name (optional)"), { target: { value: "Ann" } });
  fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  expect(await screen.findByText("Your question is waiting for approval")).toBeTruthy();
  expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ text: "Hi", authorName: "Ann" });
  expect(screen.queryByText("Hi")).toBeNull();
});

it("adds approved questions live without duplicates", async () => {
  render(<QaTab eventId="e1" initial={view([])} />);
  act(() => {
    fake.emit("question:added", { interactionId: "qa1", question: q("3", "Live one") });
    fake.emit("question:added", { interactionId: "qa1", question: q("3", "Live one") });
  });
  await waitFor(() => expect(screen.getAllByText("Live one")).toHaveLength(1));
});

it("shows server errors", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "That question contains language we can't accept" }), { status: 400 })));
  render(<QaTab eventId="e1" initial={view([])} />);
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  expect((await screen.findByRole("alert")).textContent).toContain("language we can't accept");
});

it("toggles an upvote and shows the new count", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, upvoted: true, upvotes: 4 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QaTab eventId="e1" initial={view([q("1", "Why?", { upvotes: 3 })])} />);
  const button = screen.getByRole("button", { name: "Upvote: Why?" });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(button);
  await waitFor(() => expect(button.textContent).toContain("4"));
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/interactions/qa1/questions/1/upvote");
});

it("updates counts live and sorts by Popular or Recent", async () => {
  render(
    <QaTab
      eventId="e1"
      initial={view([
        q("1", "Newer", { createdAt: "2026-01-02T00:00:00.000Z" }),
        q("2", "Older", { createdAt: "2026-01-01T00:00:00.000Z" }),
      ])}
    />,
  );
  const order = () => screen.getAllByRole("listitem").map((li) => li.textContent?.includes("Newer") ? "Newer" : "Older");
  expect(order()).toEqual(["Newer", "Older"]);
  act(() => void fake.emit("question:votes", { interactionId: "qa1", questionId: "2", upvotes: 5 }));
  expect(order()).toEqual(["Newer", "Older"]);
  fireEvent.click(screen.getByRole("button", { name: "Popular" }));
  expect(order()).toEqual(["Older", "Newer"]);
  fireEvent.click(screen.getByRole("button", { name: "Recent" }));
  expect(order()).toEqual(["Newer", "Older"]);
});

it("applies host pin/answered updates and removals live", () => {
  render(<QaTab eventId="e1" initial={view([q("1", "Older", { createdAt: "2026-01-01T00:00:00.000Z" }), q("2", "Newer", { createdAt: "2026-02-01T00:00:00.000Z" })])} />);
  act(() => void fake.emit("question:updated", { interactionId: "qa1", questionId: "1", pinned: true, answered: true }));
  const items = screen.getAllByRole("listitem");
  expect(items[0].textContent).toContain("Older");
  expect(items[0].textContent).toContain("Answered");
  act(() => void fake.emit("question:removed", { interactionId: "qa1", questionId: "1" }));
  expect(screen.queryByText("Older")).toBeNull();
});

it("posts to the shown Q&A and ignores messages meant for another one", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, status: "approved", question: q("9", "Mine") }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QaTab eventId="e1" initial={view([q("1", "Existing")])} />);
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Mine" } });
  fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  await screen.findByText("Thanks, your question was posted.");
  expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/interactions/qa1/questions");

  act(() => {
    fake.emit("question:added", { interactionId: "other", question: q("5", "Elsewhere") });
    fake.emit("question:votes", { interactionId: "other", questionId: "1", upvotes: 40 });
    fake.emit("question:removed", { interactionId: "other", questionId: "1" });
  });
  expect(screen.queryByText("Elsewhere")).toBeNull();
  expect(screen.getByText("Existing")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Upvote: Existing" }).textContent).toContain("0");
});

it("shows a paused Q&A read-only with a note", () => {
  render(<QaTab eventId="e1" initial={view([q("1", "Why?", { upvotes: 2 })], { state: "paused" })} />);
  expect(screen.getByRole("status").textContent).toContain("paused");
  expect(screen.queryByLabelText("Your question")).toBeNull();
  expect(screen.queryByRole("button", { name: "Send question" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Upvote/ })).toBeNull();
  expect(screen.getByText("Why?")).toBeTruthy();
});

it("shows a closed Q&A read-only, and lists other closed ones as earlier questions", () => {
  render(
    <QaTab
      eventId="e1"
      initial={{
        current: qa([q("1", "Latest")], { state: "closed", title: "Afternoon" }),
        earlier: [qa([q("2", "Morning one"), q("3", "Morning two")], { id: "qa0", state: "closed", title: "Morning" })],
      }}
    />,
  );
  expect(screen.getByRole("heading", { name: "Afternoon" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("closed");
  expect(screen.queryByLabelText("Your question")).toBeNull();
  expect(screen.getByRole("heading", { name: "Earlier questions" })).toBeTruthy();
  expect(screen.getByText("Morning")).toBeTruthy();
  expect(screen.getByText("2 questions")).toBeTruthy();
  expect(screen.getByText("Morning one")).toBeTruthy();
});

it("asks the server again when a state change arrives, and follows the new live Q&A", async () => {
  const next = { current: qa([q("8", "Fresh")], { id: "qa2", title: "Round two" }), earlier: [qa([q("1", "Old")], { state: "closed", title: "Round one" })] };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(next), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QaTab eventId="e1" initial={view([q("1", "Old")], { state: "closed", title: "Round one" })} />);
  expect(screen.queryByLabelText("Your question")).toBeNull();
  act(() => void fake.emit("state-changed", { interactionId: "qa2", state: "live" }));
  expect(await screen.findByRole("heading", { name: "Round two" })).toBeTruthy();
  expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/events/e1/qa");
  expect(screen.getByLabelText("Your question")).toBeTruthy();
  expect(screen.getByText("Fresh")).toBeTruthy();
  // The new Q&A is the one that live messages apply to.
  act(() => void fake.emit("question:added", { interactionId: "qa2", question: q("9", "Added") }));
  expect(screen.getByText("Added")).toBeTruthy();
});

it("still takes the first question of an event that has no Q&A yet, then adopts the Q&A the server made", async () => {
  const created = { current: qa([q("9", "First")]), earlier: [] };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: "approved", question: q("9", "First") }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QaTab eventId="e1" initial={noQa} />);
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "First" } });
  fireEvent.click(screen.getByRole("button", { name: "Send question" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/events/e1/questions");
  expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("/api/events/e1/qa");
  expect(await screen.findByRole("heading", { name: "Q&A" })).toBeTruthy();
});

it("tells participants the Q&A has not started when the host has only drafts, then opens when it starts", async () => {
  const opened = view([]);
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(opened), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<QaTab eventId="e1" initial={{ ...noQa, notOpen: true }} />);
  expect(screen.getByText("Q&A has not started")).toBeTruthy();
  expect(screen.queryByLabelText("Your question")).toBeNull();
  act(() => void fake.emit("state-changed", {}));
  expect(await screen.findByLabelText("Your question")).toBeTruthy();
  expect(screen.queryByText("Q&A has not started")).toBeNull();
});
