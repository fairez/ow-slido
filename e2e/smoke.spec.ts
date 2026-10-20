import { expect, test } from "@playwright/test";
import { verifyEmail } from "./verify-email";

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

test("host runs a poll and a participant's vote reaches the presenter page", async ({ browser, page }) => {
  const email = `host-${Date.now()}@example.com`;

  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/dashboard");
  await verifyEmail(email);

  const now = Date.now();
  await page.getByLabel("Event name").fill("E2E event");
  await page.getByLabel("Start").fill(localInput(new Date(now - 3_600_000)));
  await page.getByLabel("End").fill(localInput(new Date(now + 3_600_000)));
  await page.getByRole("button", { name: "Create event" }).click();
  const code = (await page.getByRole("status").locator("strong").nth(1).innerText()).trim();
  expect(code).toMatch(/^\d{6}$/);

  await page.getByRole("link", { name: "Manage" }).click();
  await page.getByRole("button", { name: "Add content" }).click();
  await page.getByRole("button", { name: "New poll" }).click();
  await page.getByRole("textbox", { name: "Question" }).fill("Best language?");
  await page.getByRole("textbox", { name: "Option 1" }).fill("TypeScript");
  await page.getByRole("textbox", { name: "Option 2" }).fill("Rust");
  await page.getByRole("button", { name: "Save poll" }).click();
  // The event also holds its default Q&A, so work inside the poll's row.
  const row = page.getByRole("listitem").filter({ hasText: "Best language?" });
  await row.getByRole("button", { name: "Start" }).click();
  await expect(row.getByTestId("state")).toHaveText("live");

  const presenter = await page.context().newPage();
  const presentHref = await page.getByRole("link", { name: "Open presenter view" }).getAttribute("href");
  await presenter.goto(presentHref!);
  await expect(presenter.getByRole("heading", { name: "Best language?" })).toBeVisible();

  const participantContext = await browser.newContext();
  const participant = await participantContext.newPage();
  await participant.goto(`/join/${code}`);
  await participant.waitForURL("**/e/**");
  await participant.getByLabel("TypeScript").check();
  await participant.getByRole("button", { name: "Submit" }).click();

  await expect(presenter.getByRole("progressbar", { name: "TypeScript" })).toHaveAttribute("aria-valuetext", "1 vote, 100%");
  await participantContext.close();
});
