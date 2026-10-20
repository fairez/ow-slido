import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteAccount } from "@/components/delete-account";
import { DeleteWorkspace } from "@/components/delete-workspace";

const goTo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/go-to", () => ({ goTo }));

beforeEach(() => goTo.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeleteWorkspace", () => {
  it("sends the delete only after the workspace name is typed", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DeleteWorkspace name="Acme Events" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));

    const submit = screen.getAllByRole("button", { name: "Delete workspace" }).at(-1)!;
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(submit);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Type “Acme Events” to confirm"), { target: { value: "Acme Events" } });
    expect(submit.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(submit);
    await waitFor(() => expect(goTo).toHaveBeenCalledWith("/dashboard"));
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/active", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ name: "Acme Events" }) }));
  });

  it("keeps the dialog open and shows the server message when the delete fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Billing could not be cancelled" }, { status: 502 })));
    render(<DeleteWorkspace name="Acme" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));
    fireEvent.change(screen.getByLabelText("Type “Acme” to confirm"), { target: { value: "Acme" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Delete workspace" }).at(-1)!);
    expect((await screen.findByRole("alert")).textContent).toBe("Billing could not be cancelled");
    expect(goTo).not.toHaveBeenCalled();
  });
});

describe("DeleteAccount", () => {
  it("sends the password and leaves on success", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DeleteAccount />);
    fireEvent.change(screen.getByLabelText("Confirm with your password"), { target: { value: "secret words" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith("/"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/account", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ password: "secret words" }) }));
  });

  it("shows the message and the workspaces that block it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "You are the last owner of a workspace that has other members.", reason: "sole_owner", workspaces: [{ id: "w1", name: "Acme" }] }, { status: 409 }),
      ),
    );
    render(<DeleteAccount />);
    fireEvent.change(screen.getByLabelText("Confirm with your password"), { target: { value: "secret words" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect((await screen.findByRole("alert")).textContent).toContain("last owner");
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(goTo).not.toHaveBeenCalled();
  });

  it("shows a wrong password and stays", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Your current password is not correct." }, { status: 400 })));
    render(<DeleteAccount />);
    fireEvent.change(screen.getByLabelText("Confirm with your password"), { target: { value: "bad password" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Your current password is not correct.");
    expect(screen.queryByText("You are the last owner of:")).toBeNull();
    expect(goTo).not.toHaveBeenCalled();
  });
});
