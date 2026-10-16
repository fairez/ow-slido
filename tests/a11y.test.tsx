import axe from "axe-core";
import { cleanup, render } from "@testing-library/react";
import { EventEmitter } from "node:events";
import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

const fake = new EventEmitter() as EventEmitter & { off: EventEmitter["removeListener"] };
vi.mock("@/lib/realtime/use-event-socket", () => ({
  useEventSocket: () => ({ socket: fake, status: "connected" }),
}));
vi.mock("@/components/live-participant-count", () => ({ LiveParticipantCount: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import { AuthForm } from "@/components/auth-form";
import { EventManager } from "@/components/event-manager";
import { JoinForm } from "@/components/join-form";
import { ModerationPanel } from "@/components/moderation-panel";
import { ParticipantView } from "@/components/participant-view";
import { PollManager } from "@/components/poll-manager";
import { PresenterView } from "@/components/presenter-view";

afterEach(cleanup);

/** Serious and critical axe violations in the rendered tree (color-contrast needs a real layout engine, so it is skipped). */
async function violations(ui: ReactElement) {
  const { container } = render(<main>{ui}</main>);
  const result = await axe.run(container, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

const question = (id: string, text: string) => ({
  id,
  text,
  authorName: null,
  answered: false,
  pinned: false,
  createdAt: "2030-01-01T00:00:00.000Z",
  upvotes: 2,
  upvoted: false,
});
const poll = {
  id: "i1",
  type: "poll" as const,
  title: "Lunch?",
  state: "live" as const,
  options: [
    { id: "a", label: "Pizza" },
    { id: "b", label: "Tacos" },
  ],
  multiSelect: false,
  showResultsToParticipants: true,
};

it("participant page: live poll and Q&A", async () => {
  expect(
    await violations(
      <ParticipantView eventId="e1" initial={poll} initialQuestions={[question("q1", "Why?"), question("q2", "When?")]} />,
    ),
  ).toEqual([]);
});

it("participant page: word cloud and waiting states", async () => {
  const cloud = { id: "w1", type: "wordcloud" as const, title: "One word", state: "live" as const, maxEntries: 3, remaining: 3 };
  expect(await violations(<ParticipantView eventId="e1" initial={cloud} initialQuestions={[]} />)).toEqual([]);
  cleanup();
  expect(await violations(<ParticipantView eventId="e1" initial={null} initialQuestions={[]} />)).toEqual([]);
});

it("presenter page: poll results, word cloud and idle", async () => {
  const items = [{ id: "i1", state: "live" as const }];
  const pollState = { type: "poll" as const, id: "i1", title: "Lunch?", options: poll.options, counts: { a: 3, b: 1 }, total: 4 };
  expect(await violations(<PresenterView eventId="e1" joinCode="123456" items={items} initial={pollState} />)).toEqual([]);
  cleanup();
  const cloudState = {
    type: "wordcloud" as const,
    id: "w1",
    title: "One word",
    words: [
      { word: "calm", count: 3 },
      { word: "tired", count: 1 },
    ],
    total: 4,
  };
  expect(await violations(<PresenterView eventId="e1" joinCode="123456" items={items} initial={cloudState} />)).toEqual([]);
  cleanup();
  expect(await violations(<PresenterView eventId="e1" joinCode="123456" items={[]} initial={null} />)).toEqual([]);
});

it("dashboard: event list, poll builder, moderation, auth and join forms", async () => {
  const events = [
    { id: "a", name: "Sooner", startsAt: "2030-01-01T00:00:00.000Z", endsAt: "2030-01-02T00:00:00.000Z", joinCode: "123456" },
  ];
  expect(await violations(<EventManager initialEvents={events} />)).toEqual([]);
  cleanup();
  const items = [
    { id: "i1", type: "poll" as const, title: "Lunch?", state: "draft" as const, position: 0, config: { options: poll.options } },
  ];
  expect(await violations(<PollManager eventId="e1" initialInteractions={items} />)).toEqual([]);
  cleanup();
  const host = { ...question("q1", "Why?"), status: "pending" as const };
  expect(
    await violations(<ModerationPanel eventId="e1" initialMode="moderated" initialQuestions={[host as never]} />),
  ).toEqual([]);
  cleanup();
  expect(await violations(<AuthForm mode="login" />)).toEqual([]);
  cleanup();
  expect(await violations(<JoinForm />)).toEqual([]);
});

it("harness flags an unlabeled control", async () => {
  expect((await violations(<button type="button" />)).length).toBeGreaterThan(0);
});

it("presenter result bars expose label, count and percent as text", () => {
  const pollState = { type: "poll" as const, id: "i1", title: "Lunch?", options: poll.options, counts: { a: 3, b: 1 }, total: 4 };
  const { getByRole } = render(<PresenterView eventId="e1" joinCode="123456" items={[]} initial={pollState} />);
  expect(getByRole("progressbar", { name: "Pizza" }).getAttribute("aria-valuetext")).toBe("3 votes, 75%");
});
