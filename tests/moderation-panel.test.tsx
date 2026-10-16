import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
vi.mock("@/lib/realtime/use-event-socket", () => ({
  useEventSocket: () => ({ socket: fake, status: "connected" }),
}));

import { ModerationPanel } from "@/components/moderation-panel";

const q = (id: string, text: string, extra = {}) => ({
  id,
  text,
  authorName: null,
  answered: false,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  upvotes: 0,
  upvoted: false,
  status: "approved" as const,
  ...extra,
});

beforeEach(() => fake.removeAllListeners());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("approves a pending question and moves it to the approved list", async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ ok: true, question: q("1", "Why?") }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<ModerationPanel eventId="e1" initialMode="moderated" initialQuestions={[q("1", "Why?", { status: "pending" })]} />);
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(screen.getByLabelText("Approved questions")).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/events/e1/questions/1",
    expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "approved" }) }),
  );
  expect(screen.getByText("No pending questions.")).toBeTruthy();
});

it("rejecting removes the question from the queue", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, question: null }), { status: 200 })));
  render(<ModerationPanel eventId="e1" initialMode="moderated" initialQuestions={[q("1", "Spam", { status: "pending" })]} />);
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  await waitFor(() => expect(screen.queryByText("Spam")).toBeNull());
});

it("shows new pending questions arriving over the socket", () => {
  render(<ModerationPanel eventId="e1" initialMode="moderated" initialQuestions={[]} />);
  act(() => void fake.emit("question:pending", { question: q("2", "Live one") }));
  const pending = screen.getByLabelText("Pending questions");
  expect(within(pending).getByText("Live one")).toBeTruthy();
});

it("toggles moderation mode via the event PATCH endpoint", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<ModerationPanel eventId="e1" initialMode="open" initialQuestions={[]} />);
  fireEvent.click(screen.getByLabelText(/Moderated Q&A/));
  await waitFor(() => expect(screen.getByText("Moderated")).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/events/e1",
    expect.objectContaining({ method: "PATCH", body: JSON.stringify({ moderationMode: "moderated" }) }),
  );
});

it("pin, answered and delete actions on approved questions", async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ ok: true, question: q("1", "Hello", { pinned: true, answered: true }) }), {
          status: 200,
        }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<ModerationPanel eventId="e1" initialMode="open" initialQuestions={[q("1", "Hello")]} />);
  fireEvent.click(screen.getByRole("button", { name: "Pin" }));
  await waitFor(() => expect(screen.getByText(/Pinned/)).toBeTruthy());
  expect(screen.getByText(/Answered/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByText("Hello")).toBeNull());
});

it("moderator mode sends the token, hides the mode switch and still moderates", async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ ok: true, question: q("1", "Why?") }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ModerationPanel
      eventId="e1"
      initialMode="moderated"
      initialQuestions={[q("1", "Why?", { status: "pending" })]}
      moderatorToken="tok"
    />,
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/events/e1/questions/1",
    expect.objectContaining({ headers: expect.objectContaining({ "x-moderator-token": "tok" }) }),
  );
});

const note = (id: string, text: string, extra = {}) => ({
  id,
  interactionId: "i1",
  interactionTitle: "Thoughts?",
  text,
  authorName: null,
  status: "pending" as const,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  upvotes: 0,
  ...extra,
});

it("approves a pending note and offers Pin and Delete afterwards", async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ ok: true, note: note("n1", "Idea", { status: "approved" }) }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<ModerationPanel eventId="e1" initialMode="open" initialQuestions={[]} initialNotes={[note("n1", "Idea")]} />);
  fireEvent.click(screen.getByRole("button", { name: "Approve note" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Pin note" })).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/events/e1/notes/n1",
    expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "approved" }) }),
  );
  expect(screen.getByRole("button", { name: "Delete note" })).toBeTruthy();
});

it("rejecting a note removes it from the queue", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, note: null }), { status: 200 })));
  render(<ModerationPanel eventId="e1" initialMode="open" initialQuestions={[]} initialNotes={[note("n1", "Spam")]} />);
  fireEvent.click(screen.getByRole("button", { name: "Reject note" }));
  await waitFor(() => expect(screen.queryByText("Spam")).toBeNull());
});
