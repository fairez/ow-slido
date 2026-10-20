import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpsActivity } from "@/components/ops-activity";
import { OpsAiPanel } from "@/components/ops-ai-panel";
import { OpsWorkspaceManager, type OpsDetail } from "@/components/ops-workspace-manager";
import { I18nProvider } from "@/lib/i18n/client";

const detail = (over: Partial<OpsDetail> = {}): OpsDetail => ({
  id: "w1",
  name: "Acme",
  plan: "free",
  source: "free",
  suspendedAt: null,
  suspendedReason: null,
  override: null,
  members: [
    { userId: "u1", email: "ann@example.com", role: "owner", status: "active", twoFactor: true },
    { userId: "u2", email: "bob@example.com", role: "editor", status: "active", twoFactor: false },
  ],
  ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function ui(node: React.ReactNode) {
  return render(<I18nProvider locale="en">{node}</I18nProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OpsWorkspaceManager", () => {
  it("suspends with a reason, then shows the reactivate control from the refreshed detail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json(detail({ suspendedAt: "2026-10-21T00:00:00.000Z", suspendedReason: "spam" })));
    vi.stubGlobal("fetch", fetchMock);
    ui(<OpsWorkspaceManager initial={detail()} />);

    fireEvent.change(screen.getAllByLabelText(/^Reason/)[0], { target: { value: "spam" } });
    fireEvent.click(screen.getByRole("button", { name: "Suspend workspace" }));

    await screen.findByRole("button", { name: "Reactivate workspace" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ops/workspaces/w1/suspend");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ reason: "spam" });
    expect(screen.getByRole("status").textContent).toBe("Workspace suspended.");
  });

  it("shows the server's message when the reason is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "Enter a reason of up to 300 characters." }, 400)));
    ui(<OpsWorkspaceManager initial={detail()} />);
    fireEvent.click(screen.getByRole("button", { name: "Suspend workspace" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a reason of up to 300 characters.");
  });

  it("asks before resetting 2FA and offers the reset only to members who have it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(
        json(detail({ members: [{ userId: "u1", email: "ann@example.com", role: "owner", status: "active", twoFactor: false }] })),
      );
    vi.stubGlobal("fetch", fetchMock);
    ui(<OpsWorkspaceManager initial={detail()} />);

    expect(screen.getAllByRole("button", { name: /^Reset 2FA for/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reset 2FA for ann@example.com" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset 2FA for ann@example.com?" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Two-factor authentication reset."));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ops/workspaces/w1/members/u1/reset-2fa");
    expect(screen.queryByRole("button", { name: /^Reset 2FA for/ })).toBeNull();
  });

  it("describes an active override and offers to end it", () => {
    ui(
      <OpsWorkspaceManager
        initial={detail({
          plan: "team",
          source: "override",
          override: { plan: "team", until: "2026-12-01T23:59:59.000Z", reason: "goodwill", active: true },
        })}
      />,
    );
    expect(screen.getByText(/Team until Dec 1, 2026 \(UTC\)\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "End override now" })).toBeTruthy();
  });
});

describe("OpsAiPanel", () => {
  const data = { provider: "openai" as const, model: "gpt-4o-mini", configured: true, callsToday: 12, globalDailyCap: 1000, paused: false };

  it("shows provider, model and the day's count, and runs the existing test route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json({ ...data, callsToday: 13 }));
    vi.stubGlobal("fetch", fetchMock);
    ui(<OpsAiPanel initial={data} />);
    expect(screen.getByText("gpt-4o-mini")).toBeTruthy();
    expect(screen.getByText("12 of 1,000")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("The provider answered.");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ai/test");
    expect(screen.getByText("13 of 1,000")).toBeTruthy();
  });

  it("shows the failure message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "AI is not configured." }, 503)));
    ui(<OpsAiPanel initial={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("alert")).textContent).toBe("AI is not configured.");
  });

  it("says so when no provider is set", () => {
    ui(<OpsAiPanel initial={{ ...data, provider: null, model: null, configured: false }} />);
    expect(screen.getByText("No AI provider is set on the server.")).toBeTruthy();
  });
});

describe("OpsActivity", () => {
  it("lists operator actions with the workspace they touched", () => {
    ui(
      <OpsActivity
        initial={{
          total: 1,
          page: 1,
          pageSize: 50,
          entries: [
            {
              id: "a1",
              workspaceId: "w1",
              workspaceName: "Acme",
              actorLabel: "operator:boss@example.com",
              action: "operator.workspace_suspended",
              targetType: "workspace",
              targetId: "w1",
              metadata: { reason: "spam" },
              createdAt: "2026-10-21T03:00:00.000Z",
            },
          ],
        }}
      />,
    );
    const item = within(screen.getByRole("list", { name: "Operator actions" })).getByRole("listitem");
    expect(within(item).getByText("operator.workspace_suspended")).toBeTruthy();
    expect(within(item).getByRole("link", { name: "Acme" }).getAttribute("href")).toBe("/ops/workspaces/w1");
    expect(within(item).getByText("reason: spam")).toBeTruthy();
  });
});
