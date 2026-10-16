import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
vi.mock("@/lib/realtime/use-event-socket", () => ({
  useEventSocket: () => ({ socket: fake, status: "connected" }),
}));

import { OpenTextForm } from "@/components/open-text-form";
import { OpenTextHostPanel } from "@/components/open-text-host-panel";
import { PollManager } from "@/components/poll-manager";
import { PresenterView } from "@/components/presenter-view";
import type { LiveOpenText } from "@/lib/live-view";

const question = (extra: Partial<LiveOpenText> = {}): LiveOpenText => ({
  id: "q1",
  type: "openText",
  title: "What should we fix?",
  state: "live",
  maxResponses: 2,
  remaining: 2,
  ...extra,
});

const response = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  interactionId: "q1",
  text,
  highlighted: false,
  createdAt: "2026-10-16T10:00:00.000Z",
  ...extra,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => fake.removeAllListeners());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows the counter and remaining responses, then confirms after sending", async () => {
  const fetchMock = vi.fn(async () => json({ response: response("r1", "More chairs") }, 201));
  vi.stubGlobal("fetch", fetchMock);
  render(<OpenTextForm question={question()} />);
  expect(screen.getByText("2 responses remaining")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Your response"), { target: { value: "More chairs" } });
  expect(screen.getByText("11/300")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Thanks, your response was sent.");
  expect(screen.getByText("1 response remaining")).toBeTruthy();
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/interactions/q1/responses");
  expect(JSON.parse(init.body as string)).toEqual({ text: "More chairs" });
});

it("disables the form when no responses are left and shows server errors", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "That response contains language we can't accept" }, 400)));
  render(<OpenTextForm question={question({ remaining: 1 })} />);
  fireEvent.change(screen.getByLabelText("Your response"), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("alert");
  cleanup();
  render(<OpenTextForm question={question({ remaining: 0 })} />);
  expect((screen.getByLabelText("Your response") as HTMLTextAreaElement).disabled).toBe(true);
  expect(screen.getByText("You have used all your responses.")).toBeTruthy();
});

it("shows a closed message instead of the form", () => {
  render(<OpenTextForm question={question({ state: "closed" })} />);
  expect(screen.getByText("Responses closed")).toBeTruthy();
  expect(screen.queryByLabelText("Your response")).toBeNull();
});

it("builder creates an open text interaction", async () => {
  const created = { id: "n", type: "openText", title: "Why?", state: "draft", position: 0, config: { maxResponsesPerParticipant: 2 } };
  const fetchMock = vi.fn(async () => json({ interaction: created }, 201));
  vi.stubGlobal("fetch", fetchMock);
  render(<PollManager eventId="e" initialInteractions={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "New open text" }));
  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Why?" } });
  fireEvent.change(screen.getByLabelText("Responses per participant"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Save open text" }));
  await screen.findByText("Why?");
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(init.body as string)).toEqual({ type: "openText", prompt: "Why?", maxResponsesPerParticipant: 2 });
});

it("presenter lists responses newest first, emphasises highlighted ones and updates live", () => {
  const initial = {
    type: "openText" as const,
    id: "q1",
    title: "What should we fix?",
    state: "live" as const,
    responses: [response("a", "older", { createdAt: "2026-10-16T10:00:00.000Z" }), response("b", "starred", { highlighted: true, createdAt: "2026-10-16T09:00:00.000Z" })],
  };
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={initial} />);
  expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["older", "Highlightedstarred"]);
  act(() => {
    fake.emit("response:added", { response: response("c", "newest", { createdAt: "2026-10-16T11:00:00.000Z" }) });
  });
  expect(screen.getAllByRole("listitem")[0].textContent).toBe("newest");
  act(() => {
    fake.emit("response:removed", { interactionId: "q1", responseId: "a" });
  });
  expect(screen.queryByText("older")).toBeNull();
  expect(screen.getByText("2 responses")).toBeTruthy();
});

it("host panel highlights, hides and deletes", async () => {
  const list = [{ ...response("r1", "Keep it short"), hidden: false }];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    !init || init.method === undefined ? json({ responses: list }) : json({ ok: true }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<OpenTextHostPanel eventId="e" interactionId="q1" live />);
  await screen.findByText("Keep it short");
  fireEvent.click(screen.getByRole("button", { name: "Highlight" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/responses/r1", expect.objectContaining({ method: "PATCH" })));
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  await waitFor(() => expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH")).toHaveLength(2));
  const bodies = fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH").map((c) => JSON.parse(c[1]!.body as string));
  expect(bodies).toEqual([{ highlighted: true }, { hidden: true }]);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete response" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/responses/r1", { method: "DELETE" }));
});
