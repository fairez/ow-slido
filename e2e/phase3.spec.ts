import { totp } from "../lib/auth/totp";
import { expect, test } from "./fixtures";
import { mailLink } from "./outbox";
import { endSubscription, forgetUser, setPlanFor, verifyEmail, workspaceIdOf } from "./verify-email";
import type { Page } from "@playwright/test";

const PASSWORD = "correct-horse-battery";
const OPERATOR_EMAIL = "e2e-operator@example.com";

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

async function signUp(page: Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/dashboard");
}

async function logIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
}

/** Fills the dashboard's create form. The event is running now, so a poll can go live at once. */
async function createEvent(page: Page, name: string, language?: "Bahasa Indonesia") {
  const now = Date.now();
  await page.getByLabel("Event name").fill(name);
  await page.getByLabel("Start").fill(localInput(new Date(now - 3_600_000)));
  await page.getByLabel("End").fill(localInput(new Date(now + 3_600_000)));
  if (language) await page.getByLabel("Audience language").selectOption({ label: language });
  await page.getByRole("button", { name: "Create event" }).click();
  const code = (await page.getByRole("status").locator("strong").nth(1).innerText()).trim();
  expect(code).toMatch(/^\d{6}$/);
  return code;
}

async function openEvent(page: Page) {
  await page.getByRole("link", { name: "Manage" }).click();
  await page.waitForURL("**/dashboard/events/*");
  return new URL(page.url()).pathname.split("/").pop()!;
}

test("sign-up is confirmed with the link from the outbox", async ({ page }) => {
  const email = uniqueEmail("verify");
  await signUp(page, email);
  await expect(page.getByText(`we sent a link to ${email}`, { exact: false })).toBeVisible();

  await page.goto(await mailLink(email, "verify"));
  await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();

  // A fresh load: the banner sits in the layout, which the verify page rendered before it used the token.
  await page.goto("/dashboard");
  await expect(page.getByText("Confirm your email", { exact: false })).toHaveCount(0);

  // The link works once.
  await page.goto(await mailLink(email, "verify"));
  await expect(page.getByRole("heading", { name: "This link no longer works" })).toBeVisible();
});

test("an invited viewer joins with the role they were given and can do no more", async ({ browser, page }) => {
  const owner = uniqueEmail("owner");
  await signUp(page, owner);
  await verifyEmail(owner);
  await setPlanFor(owner, "team");

  await page.goto("/dashboard/members");
  await page.getByRole("button", { name: "Invite someone" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  // Owner is not a role anyone can be invited to.
  await expect(dialog.getByRole("combobox", { name: "Role" }).getByRole("option")).toHaveText(["Admin", "Editor", "Moderator", "Viewer"]);
  const invited = uniqueEmail("viewer");
  await dialog.getByLabel("Email").fill(invited);
  await dialog.getByLabel("Role").selectOption({ label: "Viewer" });
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("dialog", { name: "Invitation created" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(invited)).toBeVisible();

  // The invited person opens the emailed link in their own browser and sets a password.
  const context = await browser.newContext();
  const viewer = await context.newPage();
  await viewer.goto(await mailLink(invited, "invite"));
  await viewer.getByLabel("New password").fill(PASSWORD);
  await viewer.getByRole("button", { name: "Create account and join" }).click();
  await viewer.waitForURL("**/dashboard");

  // A viewer cannot manage members or create events.
  await viewer.goto("/dashboard/members");
  await viewer.waitForURL("**/dashboard");
  const members = await viewer.request.get("/api/members");
  expect(members.status()).toBe(403);
  const created = await viewer.request.post("/api/events", {
    data: { name: "Not allowed", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  expect(created.status()).toBe(403);
  await context.close();

  // The owner now sees the viewer as a member and the invitation is gone.
  await page.reload();
  await expect(page.getByRole("list", { name: /members/i }).or(page.getByText(invited)).first()).toBeVisible();
  await expect(page.getByText("Pending invitations").locator("..").getByText(invited)).toHaveCount(0);
});

test("a Pro upgrade through the mock provider unlocks a type that locks again after the plan ends", async ({ page }) => {
  const email = uniqueEmail("upgrade");
  await signUp(page, email);
  await verifyEmail(email);
  await createEvent(page, "Plan event");
  const eventId = await openEvent(page);

  // Free: the ranking type is refused by the API.
  const refused = await page.request.post(`/api/events/${eventId}/interactions`, {
    data: { type: "ranking", prompt: "Rank these", options: ["One", "Two"] },
  });
  expect(refused.status()).toBe(402);

  await page.goto("/dashboard/plan");
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();
  await page.waitForURL("**/dashboard/plan?checkout=success");
  await expect(page.getByRole("status").filter({ hasText: "Your workspace is on Pro." })).toBeVisible();

  const accepted = await page.request.post(`/api/events/${eventId}/interactions`, {
    data: { type: "ranking", prompt: "Rank these", options: ["One", "Two"] },
  });
  expect(accepted.status(), await accepted.text()).toBe(201);

  // The subscription runs out. Nothing is deleted, but the ranking is read-only.
  await endSubscription(email);
  await page.goto(`/dashboard/events/${eventId}`);
  const row = page.getByRole("listitem").filter({ hasText: "Rank these" });
  await expect(row.getByText("Read-only")).toBeVisible();
  await expect(row.getByRole("link", { name: "Unlock" })).toHaveAttribute("href", "/dashboard/plan");
  await expect(row.getByRole("button", { name: "Start" })).toHaveCount(0);
  const created = (await accepted.json()).interaction as { id: string };
  const start = await page.request.post(`/api/events/${eventId}/interactions/${created.id}/start`);
  expect(start.status()).toBe(403);
});

test("login asks for an authenticator code once two-factor is on", async ({ page }) => {
  const email = uniqueEmail("twofa");
  await signUp(page, email);
  await verifyEmail(email);

  await page.goto("/account/security");
  await page.getByRole("button", { name: "Set up two-factor authentication" }).click();
  const key = (await page.locator(".security-key-label + code").innerText()).replace(/\s/g, "");
  await page.getByLabel("Code from the app").fill(totp(key, Date.now()));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await page.getByRole("button", { name: "I have saved these codes" }).click();
  await expect(page.getByText("Two-factor authentication is on.")).toBeVisible();

  // A second browser logs in: the password alone gets no session.
  const fresh = await page.context().browser()!.newContext();
  const phone = await fresh.newPage();
  await logIn(phone, email);
  await expect(phone.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  const early = await phone.request.get("/api/auth/me");
  expect((await early.json()).user ?? null).toBeNull();

  await phone.getByLabel("Authentication code").fill("000000");
  await phone.getByRole("button", { name: "Verify and log in" }).click();
  await expect(phone.getByRole("alert")).toBeVisible();

  await phone.getByLabel("Authentication code").fill(totp(key, Date.now()));
  await phone.getByRole("button", { name: "Verify and log in" }).click();
  await phone.waitForURL("**/dashboard");
  await fresh.close();
});

test("a suspended workspace shows the notice to its members until it is reactivated", async ({ browser, page }) => {
  const owner = uniqueEmail("suspended");
  await signUp(page, owner);
  await verifyEmail(owner);
  const workspaceId = await workspaceIdOf(owner);

  await forgetUser(OPERATOR_EMAIL);
  const context = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": "10.250.1.1" } });
  const operator = await context.newPage();
  await signUp(operator, OPERATOR_EMAIL);
  await verifyEmail(OPERATOR_EMAIL);

  await operator.goto(`/ops/workspaces/${workspaceId}`);
  await operator.getByLabel("Reason").first().fill("Payment dispute under review");
  await operator.getByRole("button", { name: "Suspend workspace" }).click();
  await expect(operator.getByText("Workspace suspended.")).toBeVisible();

  await page.goto("/dashboard");
  await page.waitForURL("**/account/suspended");
  await expect(page.getByRole("heading", { name: /is suspended$/ })).toBeVisible();
  await expect(page.getByText("Nothing has been deleted.", { exact: false })).toBeVisible();
  const refused = await page.request.get("/api/events");
  expect(refused.status()).toBe(403);
  expect((await refused.json()).reason).toBe("workspace_suspended");

  await operator.getByRole("button", { name: "Reactivate workspace" }).click();
  await expect(operator.getByText("Workspace reactivated.")).toBeVisible();
  await page.goto("/dashboard");
  await page.waitForURL("**/dashboard");
  await expect(page.getByLabel("Event name")).toBeVisible();
  await context.close();
});

test("an Indonesian event shows Indonesian to participants, who can switch back", async ({ browser, page }) => {
  const email = uniqueEmail("indonesia");
  await signUp(page, email);
  await verifyEmail(email);
  const code = await createEvent(page, "Acara uji", "Bahasa Indonesia");
  const eventId = await openEvent(page);

  const poll = await page.request.post(`/api/events/${eventId}/interactions`, {
    data: { type: "poll", question: "Bahasa favorit?", options: ["TypeScript", "Rust"] },
  });
  expect(poll.status(), await poll.text()).toBe(201);
  const started = await page.request.post(`/api/events/${eventId}/interactions/${(await poll.json()).interaction.id}/start`);
  expect(started.status()).toBe(200);

  const context = await browser.newContext();
  const phone = await context.newPage();
  await phone.goto(`/join/${code}`);
  await phone.waitForURL("**/e/**");
  await expect(phone.locator("html")).toHaveAttribute("lang", "id");
  await phone.getByLabel("TypeScript").check();
  await phone.getByRole("button", { name: "Kirim" }).click();
  await expect(phone.getByText("Terima kasih, suaramu sudah tercatat.")).toBeVisible();

  await phone.getByRole("group", { name: "Bahasa" }).getByRole("button", { name: "English" }).click();
  await expect(phone.locator("html")).toHaveAttribute("lang", "en");
  await context.close();
});

test("an export on a Team workspace appears in the audit log", async ({ page }) => {
  const email = uniqueEmail("audit");
  await signUp(page, email);
  await verifyEmail(email);
  await setPlanFor(email, "team");
  await createEvent(page, "Audited event");
  const eventId = await openEvent(page);

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);

  await page.goto("/dashboard/audit");
  const entry = page.getByRole("listitem").filter({ hasText: "event.exported" });
  await expect(entry.first()).toBeVisible();
  await expect(entry.first()).toContainText(email);
  expect(eventId).toBeTruthy();
});
