// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { NotesAnalysisPanel } from "@/components/notes-analysis-panel";

const running = {
  analysis: { id: "a1", status: "running", noteCount: 3, summary: null, categories: null, keywords: null, edited: false, published: false, model: null, error: null, createdAt: new Date().toISOString(), finishedAt: null, outdated: false },
  lastDone: null,
  approvedNoteCount: 3,
  noticeAccepted: true,
  notes: [],
};

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fake.removeAllListeners();
  fetchMock = vi.fn(async () => new Response(JSON.stringify(running)));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const socket = () => fake as unknown as Socket;

it("refetches when the server announces a change for this interaction only", async () => {
  render(<NotesAnalysisPanel interactionId="i1" socket={socket()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  act(() => void fake.emit("analysis:updated", { interactionId: "other" }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  act(() => void fake.emit("analysis:updated", { interactionId: "i1" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

it("does not poll every two seconds while a job runs when a socket is connected", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<NotesAnalysisPanel interactionId="i1" socket={socket()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => void (await vi.advanceTimersByTimeAsync(6_000)));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

it("falls back to a short poll when there is no socket", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<NotesAnalysisPanel interactionId="i1" />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await act(async () => void (await vi.advanceTimersByTimeAsync(3_500)));
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
});
