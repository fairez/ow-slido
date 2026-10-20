import axe from "axe-core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
const toDataURL = vi.fn<(text: string) => Promise<string>>(async () => "data:image/png;base64,QR");
vi.mock("qrcode", () => ({ default: { toDataURL: (text: string) => toDataURL(text) } }));

import { AuthForm } from "@/components/auth-form";
import { SecuritySettings } from "@/components/security-settings";

const wrap = (node: React.ReactNode) => <I18nProvider locale="en">{node}</I18nProvider>;

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[];

/** Answers by path; each handler returns a Response. */
function stubFetch(routes: Record<string, (body: Record<string, unknown>) => Response>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body ?? "{}"));
      calls.push({ url, body });
      const route = routes[url];
      if (!route) throw new Error(`unexpected fetch ${url}`);
      return route(body);
    }),
  );
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  toDataURL.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function logInWithPassword() {
  render(wrap(<AuthForm mode="login" />));
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-pass-1" } });
  fireEvent.submit(screen.getByRole("button", { name: "Log in" }).closest("form")!);
  await screen.findByRole("heading", { name: "Enter your code" });
}

it("shows the code step after a correct password and sends the pending token with the code", async () => {
  stubFetch({
    "/api/auth/login": () => Response.json({ twoFactorRequired: true, pendingToken: "2fa-pending.tok" }),
    "/api/auth/2fa/verify": () => Response.json({ user: { id: "u1" } }),
  });
  await logInWithPassword();
  expect(push).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByLabelText("Authentication code"));

  fireEvent.change(screen.getByLabelText("Authentication code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify and log in" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  expect(calls[1]).toEqual({ url: "/api/auth/2fa/verify", body: { pendingToken: "2fa-pending.tok", code: "123456" } });
});

it("offers a recovery code as a labelled alternative and announces a wrong code", async () => {
  let attempts = 0;
  stubFetch({
    "/api/auth/login": () => Response.json({ twoFactorRequired: true, pendingToken: "2fa-pending.tok" }),
    "/api/auth/2fa/verify": () =>
      ++attempts === 1 ? Response.json({ error: "That code is not correct." }, { status: 401 }) : Response.json({ user: { id: "u1" } }),
  });
  await logInWithPassword();

  fireEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
  const field = screen.getByLabelText("Recovery code");
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: "ABCDE-FGHIJ" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify and log in" }));
  expect((await screen.findByRole("alert")).textContent).toBe("That code is not correct.");
  expect(push).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Verify and log in" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  expect(calls.at(-1)?.body).toEqual({ pendingToken: "2fa-pending.tok", code: "ABCDE-FGHIJ" });

});

it("goes back to the password form from the code step", async () => {
  stubFetch({ "/api/auth/login": () => Response.json({ twoFactorRequired: true, pendingToken: "2fa-pending.tok" }) });
  await logInWithPassword();
  fireEvent.click(screen.getByRole("button", { name: "Back to log in" }));
  expect(screen.getByRole("heading", { name: "Log in" })).toBeTruthy();
});

it("a plain login still goes straight to the dashboard", async () => {
  stubFetch({ "/api/auth/login": () => Response.json({ user: { id: "u1" } }) });
  render(wrap(<AuthForm mode="login" />));
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-pass-1" } });
  fireEvent.submit(screen.getByRole("button", { name: "Log in" }).closest("form")!);
  await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
});

it("sets up 2FA: QR drawn locally, key shown as text, recovery codes shown once", async () => {
  const codes = Array.from({ length: 10 }, (_, i) => `AAAA${i}-BBBB${i}`);
  stubFetch({
    "/api/auth/2fa/enrol": () => Response.json({ secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/OW%20Slido:a@example.com?secret=JBSWY3DPEHPK3PXP" }),
    "/api/auth/2fa/confirm": (body) =>
      body.code === "123456" ? Response.json({ recoveryCodes: codes }) : Response.json({ error: "Wrong code." }, { status: 400 }),
  });
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(wrap(<SecuritySettings email="a@example.com" available enabled={false} recoveryCodesLeft={0} />));

  expect(screen.getByText("Two-factor authentication is off.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Set up two-factor authentication" }));
  await screen.findByRole("heading", { name: "Set up your authenticator" });
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Set up your authenticator" }));
  expect(toDataURL).toHaveBeenCalledWith(expect.stringContaining("otpauth://totp/"));
  expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,QR");
  expect(screen.getByText("JBSW Y3DP EHPK 3PXP")).toBeTruthy();
  // Nothing sensitive in the address bar.
  expect(window.location.href).not.toContain("JBSW");

  fireEvent.change(screen.getByLabelText("Code from the app"), { target: { value: "000000" } });
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Wrong code.");

  fireEvent.change(screen.getByLabelText("Code from the app"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  await screen.findByRole("heading", { name: "Save your recovery codes" });
  expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(codes);

  fireEvent.click(screen.getByRole("button", { name: "Copy codes" }));
  await screen.findByText("Codes copied.");
  expect(writeText).toHaveBeenCalledWith(codes.join("\n"));

  fireEvent.click(screen.getByRole("button", { name: "I have saved these codes" }));
  expect(screen.getByText("Two-factor authentication is on.")).toBeTruthy();
  expect(screen.getByText("Recovery codes left: 10.")).toBeTruthy();
  // The codes are gone for good once the panel is dismissed.
  expect(screen.queryByText(codes[0])).toBeNull();
});

it("turns 2FA off with the password and a code", async () => {
  stubFetch({
    "/api/auth/2fa/disable": (body) =>
      body.password === "right" ? Response.json({ ok: true }) : Response.json({ error: "Your password or code is not correct." }, { status: 400 }),
  });
  render(wrap(<SecuritySettings email="a@example.com" available enabled recoveryCodesLeft={7} />));
  expect(screen.getByText("Recovery codes left: 7.")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
  fireEvent.change(screen.getByLabelText("Authentication or recovery code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Your password or code is not correct.");

  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "right" } });
  fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
  await screen.findByText(/now off/);
  expect(calls.at(-1)?.body).toEqual({ password: "right", code: "123456" });
  expect(screen.getByRole("button", { name: "Set up two-factor authentication" })).toBeTruthy();
});

it("says so when the server has no encryption key", () => {
  render(wrap(<SecuritySettings email="a@example.com" available={false} enabled={false} recoveryCodesLeft={0} />));
  expect(screen.getByText(/not available on this server/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

it("has no serious accessibility violations on the code step or the security screens", async () => {
  const check = async () => {
    const result = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);
  };
  stubFetch({ "/api/auth/login": () => Response.json({ twoFactorRequired: true, pendingToken: "t" }) });
  await logInWithPassword();
  expect(await check()).toEqual([]);
  cleanup();
  render(wrap(<SecuritySettings email="a@example.com" available enabled recoveryCodesLeft={4} />));
  expect(await check()).toEqual([]);
  cleanup();
  render(wrap(<SecuritySettings email="a@example.com" available enabled={false} recoveryCodesLeft={0} />));
  expect(await check()).toEqual([]);
});
