import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MembersManager } from "@/components/members-manager";
import { PollManager } from "@/components/poll-manager";
import { PlanHint } from "@/components/plan-hint";
import { aiLock, lockedTypes, seatLock } from "@/lib/plan-hints";
import { PLANS } from "@/lib/plans";

afterEach(cleanup);

describe("plan hint helpers", () => {
  it("lists what Free leaves out and the cheapest tier that has it", () => {
    expect(lockedTypes(PLANS.free)).toEqual({
      ranking: { requiredPlan: "pro" },
      quiz: { requiredPlan: "pro" },
      survey: { requiredPlan: "pro" },
    });
    expect(lockedTypes(PLANS.pro)).toEqual({});
  });

  it("locks AI only when the plan has no calls", () => {
    expect(aiLock(PLANS.free)).toEqual({ requiredPlan: "pro" });
    expect(aiLock(PLANS.pro)).toBeUndefined();
  });

  it("locks seats when full and points at the next tier with room", () => {
    expect(seatLock(PLANS.free, 0)).toBeUndefined();
    expect(seatLock(PLANS.free, 1)).toEqual({ requiredPlan: "pro" });
    expect(seatLock(PLANS.pro, 3)).toEqual({ requiredPlan: "team" });
    expect(seatLock(PLANS.team, 15)).toEqual({ requiredPlan: null });
  });
});

describe("PlanHint", () => {
  it("is a link to the plan page that names the tier", () => {
    render(<PlanHint lock={{ requiredPlan: "pro" }}>Export CSV</PlanHint>);
    const link = screen.getByRole("link", { name: "Export CSV Pro plan" });
    expect(link.getAttribute("href")).toBe("/dashboard/plan");
  });

  it("says the limit is reached when no tier has more", () => {
    render(<PlanHint lock={{ requiredPlan: null }}>Invite someone</PlanHint>);
    expect(screen.getByRole("link", { name: "Invite someone Limit reached" })).toBeTruthy();
  });
});

describe("gated actions in the host screens", () => {
  it("keeps a locked type visible as a link instead of a button", () => {
    render(<PollManager eventId="e" initialInteractions={[]} lockedTypes={{ rating: { requiredPlan: "pro" } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    expect(screen.queryByRole("button", { name: "New rating" })).toBeNull();
    expect(screen.getByRole("link", { name: "New rating Pro plan" }).getAttribute("href")).toBe("/dashboard/plan");
    fireEvent.click(screen.getByRole("button", { name: "New poll" }));
    expect(screen.getByLabelText("Question")).toBeTruthy();
  });

  it("shows a downgraded interaction as read-only with a pointer to the plan that unlocks it", () => {
    const poll = { id: "p", type: "poll" as const, title: "Lunch?", state: "draft" as const, position: 0, config: { options: [] } };
    const other = { ...poll, id: "q", title: "Dinner?" };
    render(<PollManager eventId="e" initialInteractions={[poll, other]} itemLocks={{ p: { requiredPlan: "pro" } }} />);
    const [locked, open] = screen.getAllByRole("listitem");
    expect(locked.textContent).toContain("Read-only");
    expect(locked.querySelector('a[href="/dashboard/plan"]')?.textContent).toContain("Pro plan");
    const labels = (li: HTMLElement) => [...li.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels(locked)).not.toContain("Start");
    expect(labels(locked)).toContain("Delete");
    expect(labels(locked)).not.toContain("Edit");
    expect(labels(locked)).not.toContain("Duplicate");
    expect(labels(open)).toContain("Start");
  });

  it("hides the add bar and reordering when the whole event is read-only", () => {
    const poll = { id: "p", type: "poll" as const, title: "Lunch?", state: "draft" as const, position: 0, config: { options: [] } };
    render(<PollManager eventId="e" initialInteractions={[poll]} eventLock={{ requiredPlan: "pro" }} itemLocks={{ p: { requiredPlan: "pro" } }} />);
    expect(screen.queryByRole("button", { name: "New poll" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Move Lunch\? up/ })).toBeNull();
  });

  it("swaps the analysis panel for a hint when the plan has no AI, and does nothing when AI is off", () => {
    const notes = { id: "n", type: "sharedNotes" as const, title: "Notes", state: "live" as const, position: 0, config: {} };
    render(<PollManager eventId="e" initialInteractions={[notes]} aiEnabled aiLock={{ requiredPlan: "pro" }} />);
    expect(screen.getByRole("link", { name: "Analyze notes Pro plan" })).toBeTruthy();
    cleanup();
    render(<PollManager eventId="e" initialInteractions={[notes]} aiLock={{ requiredPlan: "pro" }} />);
    expect(screen.queryByText(/Pro plan/)).toBeNull();
  });

  const owner = { userId: "o", email: "o@x.test", role: "owner" as const, status: "active" as const, joinedAt: "2026-01-01T00:00:00.000Z", lastLoginAt: null, twoFactor: false };
  const tiers = { current: "free" as const, tiers: (["free", "pro", "team"] as const).map((plan) => ({ plan, seats: PLANS[plan].seats })) };

  it("turns the invite button into a hint when every seat is taken", () => {
    render(<MembersManager selfId="o" actorRole="owner" initialMembers={[owner]} initialInvitations={[]} seatTiers={tiers} />);
    expect(screen.queryByRole("button", { name: "Invite someone" })).toBeNull();
    expect(screen.getByRole("link", { name: "Invite someone Pro plan" }).getAttribute("href")).toBe("/dashboard/plan");
  });

  it("keeps the invite button while a seat is free", () => {
    render(<MembersManager selfId="o" actorRole="owner" initialMembers={[owner]} initialInvitations={[]} seatTiers={{ ...tiers, current: "pro" }} />);
    expect(screen.getByRole("button", { name: "Invite someone" })).toBeTruthy();
  });
});
