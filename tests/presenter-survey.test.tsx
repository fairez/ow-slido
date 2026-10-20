import { act, cleanup, render, screen, within } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
vi.mock("@/lib/realtime/use-event-socket", () => ({
  useEventSocket: () => ({ socket: fake, status: "connected" }),
}));

import { PresenterView } from "@/components/presenter-view";
import type { PresenterSurvey } from "@/lib/presenter";

const survey = (total = 4): PresenterSurvey => ({
  type: "survey",
  id: "s1",
  title: "Feedback",
  state: "live",
  results: {
    interactionId: "s1",
    total,
    completed: 3,
    questions: [
      {
        id: "q1",
        kind: "choice",
        text: "Favourite?",
        required: true,
        answered: 4,
        multiple: false,
        options: [
          { id: "a", text: "Red", count: 3, percent: 75 },
          { id: "b", text: "Green", count: 1, percent: 25 },
        ],
      },
      { id: "q2", kind: "rating", text: "How good?", required: false, answered: 2, scale: "stars5", average: 4.5, distribution: [0, 0, 0, 1, 1] },
      { id: "q3", kind: "openText", text: "Anything else?", required: false, answered: 1, latest: ["More coffee"] },
    ],
  },
});

beforeEach(() => fake.removeAllListeners());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = (initialSurvey: PresenterSurvey | null) =>
  render(<PresenterView eventId="e1" joinCode="1234" items={[]} initial={null} initialScreen="survey" initialSurvey={initialSurvey} />);

it("prints response and completion counts, then each question's results", () => {
  view(survey());
  expect(screen.getByRole("heading", { level: 1, name: "Feedback" })).toBeTruthy();
  expect(screen.getByText(/4 responses · 3 completed/)).toBeTruthy();

  const choice = screen.getByRole("heading", { name: /Favourite\?/ }).closest("li")!;
  expect(within(choice).getByText("3 (75%)")).toBeTruthy();
  expect(within(choice).getByText("1 (25%)")).toBeTruthy();

  const rating = screen.getByRole("heading", { name: /How good\?/ }).closest("li")!;
  expect(within(rating).getByText(/4\.5/)).toBeTruthy();
  expect(within(rating).getAllByText("1 (50%)")).toHaveLength(2);

  const open = screen.getByRole("heading", { name: /Anything else\?/ }).closest("li")!;
  expect(within(open).getByText("More coffee")).toBeTruthy();
});

it("follows survey:results for its own survey only", () => {
  view(survey(4));
  const next = survey(5).results;
  act(() => {
    fake.emit("survey:results", { results: { ...next, interactionId: "other" } });
  });
  expect(screen.getByText(/4 responses/)).toBeTruthy();
  act(() => {
    fake.emit("survey:results", { results: next });
  });
  expect(screen.getByText(/5 responses/)).toBeTruthy();
});

it("says so when the survey cannot be shown, and the back button leaves the screen", () => {
  view(null);
  expect(screen.getByRole("heading", { level: 1, name: "This survey is not open for results yet." })).toBeTruthy();
  act(() => screen.getByRole("button", { name: "Back to the live screen" }).click());
  expect(screen.getByText("No live interaction")).toBeTruthy();
});
