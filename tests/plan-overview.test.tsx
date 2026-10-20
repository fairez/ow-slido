import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlanOverview } from "@/components/plan-overview";
import { t } from "@/lib/i18n";
import { resolveEntitlements, type SubscriptionRow } from "@/lib/plans";
import type { WorkspaceUsage } from "@/lib/usage";

afterEach(cleanup);

const usage: WorkspaceUsage = { seats: 1, eventsThisMonth: 2, participantsPeak: 40, aiCallsThisMonth: 0, storageMb: 0 };
const tr = (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]) => t("en", key, params);
const NOW = new Date("2026-10-20T12:00:00Z");

function row(patch: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    id: "s",
    workspaceId: "w",
    plan: "pro",
    status: "active",
    interval: "month",
    currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
    provider: null,
    providerCustomerId: null,
    providerSubscriptionId: null,
    planOverride: null,
    planOverrideUntil: null,
    planOverrideReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function view(entitlements = resolveEntitlements(null, NOW), canManageBilling = true, u = usage) {
  return render(<PlanOverview entitlements={entitlements} usage={u} canManageBilling={canManageBilling} locale="en" t={tr} />);
}

describe("PlanOverview", () => {
  it("prints the numbers next to each progress bar", () => {
    view();
    const events = screen.getByRole("progressbar", { name: "Events this month" }) as HTMLProgressElement;
    expect(events.value).toBe(2);
    expect(events.max).toBe(3);
    expect(events.getAttribute("aria-valuetext")).toBe("2 of 3");
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(screen.getByText("40 of 100")).toBeTruthy();
  });

  it("says what is not included instead of drawing an empty bar, and names the tier that has it", () => {
    view();
    expect(screen.queryByRole("progressbar", { name: "AI calls this month" })).toBeNull();
    expect(screen.queryByRole("progressbar", { name: "Image storage" })).toBeNull();
    expect(screen.getAllByText("Not included in your plan. Starts with Pro.")).toHaveLength(2);
  });

  it("marks a used-up limit in words as well as colour", () => {
    view(undefined, true, { ...usage, seats: 1 });
    const seats = screen.getByRole("progressbar", { name: "Seats" });
    expect(seats.hasAttribute("data-full")).toBe(true);
    expect(screen.getByText("Limit reached")).toBeTruthy();
  });

  it("shows unlimited events as a plain count", () => {
    view(resolveEntitlements(row({}), NOW), true, { ...usage, eventsThisMonth: 12 });
    expect(screen.getByText("12, no limit")).toBeTruthy();
    expect(screen.getByText("0 of 300")).toBeTruthy();
    expect(screen.getByText("0 MB of 1 GB")).toBeTruthy();
  });

  it("shows prices and disabled change buttons to roles that manage billing", () => {
    view();
    expect(screen.getByText("$12 a month, $120 a year")).toBeTruthy();
    expect(screen.getByText("$49 a month, $490 a year")).toBeTruthy();
    const upgrade = screen.getByRole("button", { name: "Upgrade to Pro" }) as HTMLButtonElement;
    expect(upgrade.disabled).toBe(true);
    expect(screen.getByText("Changing plans is not available yet. Billing is still being set up.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();
  });

  it("offers a switch down from a paid plan", () => {
    view(resolveEntitlements(row({ plan: "team" }), NOW));
    expect(screen.getByRole("button", { name: "Switch to Free" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch to Pro" })).toBeTruthy();
  });

  it("hides price and buttons from everyone else but keeps the usage", () => {
    view(undefined, false);
    expect(screen.queryByText(/\$\d+ a month/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Prices and plan changes are only shown to the workspace owner.")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Events this month" })).toBeTruthy();
  });

  it("marks the current tier", () => {
    view(resolveEntitlements(row({}), NOW));
    const tiers = screen.getAllByRole("heading", { level: 3 });
    expect(tiers.map((h) => h.textContent)).toEqual(["Free", "Pro", "Team"]);
    const pro = tiers[1].closest("li") as HTMLElement;
    expect(within(pro).getByText("Current plan")).toBeTruthy();
    expect(screen.getByText("Current period ends 2026-11-01.")).toBeTruthy();
  });

  it("explains a failed payment and a cancellation with the date", () => {
    const pastDue = resolveEntitlements(row({ status: "past_due", currentPeriodEnd: new Date("2026-10-18T00:00:00Z") }), NOW);
    view(pastDue);
    expect(screen.getByText(/The last payment failed\. Pro stays until 2026-10-25/)).toBeTruthy();
    cleanup();
    view(resolveEntitlements(row({ status: "canceled" }), NOW));
    expect(screen.getByText(/Canceled\. Pro stays until 2026-11-01/)).toBeTruthy();
  });
});
