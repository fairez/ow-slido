import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanOverview } from "@/components/plan-overview";
import { goTo } from "@/lib/go-to";
import type { BillingControls } from "@/lib/billing/status";
import { t } from "@/lib/i18n";
import { resolveEntitlements, type SubscriptionRow } from "@/lib/plans";
import type { WorkspaceUsage } from "@/lib/usage";

const refresh = vi.fn();
vi.mock("@/lib/go-to", () => ({ goTo: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockClear();
});

const READY: BillingControls = { configured: true, portal: false, cancel: false, changeVia: "checkout" };
const SUBSCRIBED: BillingControls = { configured: true, portal: true, cancel: true, changeVia: "checkout" };

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
    pastDueSince: null,
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

function view(
  entitlements = resolveEntitlements(null, NOW),
  canManageBilling = true,
  u = usage,
  extra: { billing?: BillingControls; checkout?: "success" | "canceled" | null } = {},
) {
  return render(
    <PlanOverview entitlements={entitlements} usage={u} canManageBilling={canManageBilling} billing={READY} locale="en" t={tr} {...extra} />,
  );
}

/** Answers each fetch with the next entry and records the calls. */
function stubFetch(...replies: { status?: number; body: unknown }[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = replies.shift() ?? { body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
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
    expect(screen.getAllByText("Not included in your plan. Starts with Pro.")).toHaveLength(1);
  });

  it("leaves out image storage and PDF/Excel reports, which are not built", () => {
    view();
    expect(screen.queryByText("Image storage")).toBeNull();
    expect(screen.queryByText(/image storage/i)).toBeNull();
    expect(screen.queryByText(/Reports as/)).toBeNull();
    expect(screen.queryByText(/PDF|XLSX/)).toBeNull();
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
  });

  it("shows the monthly price first and the yearly price after the toggle", () => {
    view();
    expect(screen.getByText("$12 a month")).toBeTruthy();
    expect(screen.getByText("$49 a month")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Yearly" }));
    expect(screen.getByText("$120 a year")).toBeTruthy();
    expect(screen.getByText("$490 a year")).toBeTruthy();
    expect(screen.queryByText("$12 a month")).toBeNull();
  });

  it("starts checkout for the chosen plan and interval, then follows the returned link", async () => {
    const calls = stubFetch({ body: { url: "https://pay.example/checkout" } });
    view();
    fireEvent.click(screen.getByRole("radio", { name: "Yearly" }));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Team" }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith("https://pay.example/checkout"));
    expect(calls).toEqual([{ url: "/api/billing/checkout", body: { plan: "team", interval: "year" } }]);
  });

  it("shows the server's reason when checkout is refused", async () => {
    stubFetch({ status: 403, body: { error: "Verify your email first" } });
    view();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Verify your email first");
    expect((screen.getByRole("button", { name: "Upgrade to Pro" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends a plan change on a live Stripe subscription to the portal", async () => {
    const calls = stubFetch({ body: { url: "https://pay.example/portal" } });
    view(resolveEntitlements(row({}), NOW), true, usage, { billing: { ...SUBSCRIBED, changeVia: "portal" } });
    expect(screen.getByText(/Plan changes are made in the billing portal/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Team" }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith("https://pay.example/portal"));
    expect(calls[0].url).toBe("/api/billing/portal");
  });

  it("explains that plans cannot change when no billing provider is set up", () => {
    view(undefined, true, usage, { billing: { ...READY, configured: false } });
    expect(screen.getByText(/Online payments are not set up/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).toBeNull();
  });

  it("offers a switch down from Team to Pro and none to Free", () => {
    view(resolveEntitlements(row({ plan: "team" }), NOW), true, usage, { billing: SUBSCRIBED });
    expect(screen.getByRole("button", { name: "Switch to Pro" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Switch to Free|Upgrade to Free/ })).toBeNull();
  });

  it("opens the portal from Manage billing", async () => {
    const calls = stubFetch({ body: { url: "https://pay.example/portal" } });
    view(resolveEntitlements(row({}), NOW), true, usage, { billing: SUBSCRIBED });
    fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith("https://pay.example/portal"));
    expect(calls[0].url).toBe("/api/billing/portal");
  });

  it("asks before canceling and names the date access ends", async () => {
    const calls = stubFetch({ body: { ok: true } });
    view(resolveEntitlements(row({}), NOW), true, usage, { billing: SUBSCRIBED });
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel Pro?" });
    expect(within(dialog).getByText(/Pro stays available until Nov 1, 2026, then the workspace returns to Free/)).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel subscription" }));
    expect((await screen.findByRole("status")).textContent).toBe("Canceled. Pro stays until Nov 1, 2026.");
    expect(calls).toEqual([{ url: "/api/billing/cancel", body: {} }]);
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the plan when the dialog is dismissed", () => {
    const calls = stubFetch();
    view(resolveEntitlements(row({}), NOW), true, usage, { billing: SUBSCRIBED });
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep Pro" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("shows no cancel button once the subscription is canceled", () => {
    view(resolveEntitlements(row({ status: "canceled" }), NOW), true, usage, { billing: { ...SUBSCRIBED, cancel: false } });
    expect(screen.queryByRole("button", { name: "Cancel subscription" })).toBeNull();
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeTruthy();
  });

  it("shows the payment-failed banner with the end of the grace period, and nothing otherwise", () => {
    const pastDue = resolveEntitlements(row({ status: "past_due", currentPeriodEnd: new Date("2026-10-18T00:00:00Z") }), NOW);
    view(pastDue, true, usage, { billing: SUBSCRIBED });
    const banner = screen.getByRole("heading", { name: "The last payment failed" }).closest("section") as HTMLElement;
    expect(within(banner).getByText(/Pro stays on until Oct 25, 2026/)).toBeTruthy();
    expect(within(banner).getByRole("button", { name: "Manage billing" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Manage billing" })).toHaveLength(1);
    cleanup();
    view(resolveEntitlements(row({}), NOW), true, usage, { billing: SUBSCRIBED });
    expect(screen.queryByRole("heading", { name: "The last payment failed" })).toBeNull();
  });

  it("tells non-owners about the failed payment without a button", () => {
    const pastDue = resolveEntitlements(row({ status: "past_due", currentPeriodEnd: new Date("2026-10-18T00:00:00Z") }), NOW);
    view(pastDue, false, usage, { billing: SUBSCRIBED });
    expect(screen.getByText("Only the workspace owner can update payment details.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reports how checkout ended", () => {
    view(resolveEntitlements(row({}), NOW), true, usage, { checkout: "success" });
    expect(screen.getByRole("status").textContent).toBe("Your workspace is on Pro.");
    cleanup();
    view(undefined, true, usage, { checkout: "success" });
    expect(screen.getByRole("status").textContent).toMatch(/changes as soon as the payment is confirmed/);
    cleanup();
    view(undefined, true, usage, { checkout: "canceled" });
    expect(screen.getByRole("status").textContent).toBe("Checkout was canceled. Nothing was charged.");
  });

  it("hides price and buttons from everyone else but keeps the usage", () => {
    view(undefined, false);
    expect(screen.queryByText(/\$\d+ a (month|year)/)).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
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
    expect(screen.getByText("Renews Nov 1, 2026.")).toBeTruthy();
  });

  it("explains a cancellation with the date", () => {
    view(resolveEntitlements(row({ status: "canceled" }), NOW));
    expect(screen.getByText(/Canceled\. Pro stays until Nov 1, 2026/)).toBeTruthy();
  });

  it("writes dates in Indonesian when the host language is Indonesian", () => {
    render(
      <PlanOverview
        entitlements={resolveEntitlements(row({ status: "canceled" }), NOW)}
        usage={usage}
        canManageBilling
        billing={READY}
        locale="id"
        t={(key, params) => t("id", key, params)}
      />,
    );
    expect(screen.getByText(/Dibatalkan\. Paket Pro berlaku sampai 1 Nov 2026/)).toBeTruthy();
  });
});
