import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpsWorkspaces,
  type OpsPageData,
  type OpsWorkspaceRow,
} from "@/components/ops-workspaces";
import { I18nProvider } from "@/lib/i18n/client";

const row = (
  n: number,
  over: Partial<OpsWorkspaceRow> = {},
): OpsWorkspaceRow => ({
  id: `w${n}`,
  name: `Workspace ${n}`,
  plan: "pro",
  status: "active",
  seatsUsed: 3,
  members: 2,
  eventsThisMonth: 4,
  aiCallsThisMonth: 12,
  ownerEmail: `owner${n}@example.com`,
  suspendedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});
const page = (
  workspaces: OpsWorkspaceRow[],
  over: Partial<OpsPageData> = {},
): OpsPageData => ({
  workspaces,
  total: workspaces.length,
  page: 1,
  pageSize: 25,
  ...over,
});

function ui(initial: OpsPageData) {
  return render(
    <I18nProvider locale="en">
      <OpsWorkspaces initial={initial} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OpsWorkspaces", () => {
  it("shows plan, status, seats, members, events and AI calls per workspace", () => {
    ui(
      page([row(1), row(2, { plan: "free", status: null, ownerEmail: null })]),
    );
    const items = within(
      screen.getByRole("list", { name: "Workspaces" }),
    ).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Pro")).toBeTruthy();
    expect(
      within(items[0]).getByText("Owner: owner1@example.com"),
    ).toBeTruthy();
    expect(
      within(items[0]).getByText("Events this month").nextElementSibling
        ?.textContent,
    ).toBe("4");
    expect(
      within(items[0]).getByText("AI calls this month").nextElementSibling
        ?.textContent,
    ).toBe("12");
    expect(within(items[1]).getByText("No subscription")).toBeTruthy();
    expect(within(items[1]).getByText("No owner")).toBeTruthy();
  });

  it("searches through the API and shows the empty-match message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(page([])), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    ui(page([row(1)]));
    fireEvent.change(
      screen.getByLabelText("Search by workspace name or owner email", {
        selector: "input",
      }),
      { target: { value: " zzz " } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(screen.getByText("No workspace matches")).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/ops/workspaces?q=zzz");
  });

  it("pages with aria-disabled ends and keeps the search term", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(page([row(26)], { page: 2, total: 26 })), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    ui(page([row(1)], { total: 26 }));
    expect(
      screen
        .getByRole("button", { name: "Previous" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Page 2 of 2")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/ops/workspaces?page=2");
    expect(
      screen
        .getByRole("button", { name: "Next" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });
});
