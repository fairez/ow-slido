import { expect, test, type Page } from "@playwright/test";

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

async function createEvent(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(`host-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/dashboard");
  const now = Date.now();
  await page.getByLabel("Event name").fill("Notes e2e");
  await page.getByLabel("Start").fill(localInput(new Date(now - 3_600_000)));
  await page.getByLabel("End").fill(localInput(new Date(now + 3_600_000)));
  await page.getByRole("button", { name: "Create event" }).click();
  const code = (await page.getByRole("status").locator("strong").nth(1).innerText()).trim();
  await page.getByRole("link", { name: "Manage" }).click();
  return code;
}

async function addInteraction(page: Page, button: string, prompt: string, save: string) {
  await page.getByRole("button", { name: button }).click();
  await page.getByLabel("Prompt").fill(prompt);
  await page.getByRole("button", { name: save }).click();
}

async function startOnly(page: Page, title: string) {
  const row = page.getByRole("listitem").filter({ hasText: title });
  await row.getByRole("button", { name: "Start" }).click();
  await expect(row.getByText("live", { exact: true }).first()).toBeVisible();
}

async function join(browser: import("@playwright/test").Browser, code: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/join/${code}`);
  await page.waitForURL("**/e/**");
  return { context, page };
}

test("shared notes with moderation and AI analysis, then open text and rating", async ({ browser, page }) => {
  const code = await createEvent(page);

  await page.getByRole("button", { name: "New shared notes" }).click();
  await page.getByLabel("Prompt").fill("What should we improve?");
  await page.getByLabel("Moderated: notes wait for approval").check();
  await page.getByRole("button", { name: "Save shared notes" }).click();
  await startOnly(page, "What should we improve?");

  const presenter = await page.context().newPage();
  await presenter.goto((await page.getByRole("link", { name: "Open presenter view" }).getAttribute("href"))!);

  const one = await join(browser, code);
  const two = await join(browser, code);
  await one.page.getByLabel("Your note").fill("Shorter meetings please");
  await one.page.getByRole("button", { name: "Send note" }).click();
  await expect(one.page.getByText(/waiting for approval/i).first()).toBeVisible();
  await two.page.getByLabel("Your note").fill("Better coffee");
  await two.page.getByRole("button", { name: "Send note" }).click();
  await expect(two.page.getByText(/waiting for approval/i).first()).toBeVisible();

  // The host approves both notes from the event page.
  await page.reload();
  const pending = page.getByRole("list", { name: "Pending notes" });
  await expect(pending.getByRole("listitem")).toHaveCount(2);
  // After a reload the server-rendered button can be clicked before React hydrates; retry until it works.
  await expect(async () => {
    await pending.getByRole("listitem").first().getByRole("button", { name: "Approve" }).click();
    await expect(pending.getByRole("listitem")).toHaveCount(1, { timeout: 3000 });
  }).toPass({ timeout: 20_000 });
  await pending.getByRole("listitem").first().getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("list", { name: "Approved notes" }).getByRole("listitem")).toHaveCount(2);

  // Each participant upvotes the other's note.
  await expect(one.page.getByRole("button", { name: "Upvote: Better coffee" })).toBeVisible();
  await one.page.getByRole("button", { name: "Upvote: Better coffee" }).click();
  await expect(one.page.getByRole("button", { name: "Upvote: Better coffee" })).toHaveAttribute("aria-pressed", "true");
  await two.page.getByRole("button", { name: "Upvote: Shorter meetings please" }).click();
  await expect(two.page.getByRole("button", { name: "Upvote: Shorter meetings please" })).toHaveAttribute("aria-pressed", "true");

  // Manual analysis with the mock provider.
  await page.reload();
  const panel = page.getByRole("region", { name: "Analyze notes" });
  await panel.getByLabel(/third-party AI service/).check();
  await panel.getByRole("button", { name: "Analyze notes" }).click();
  await expect(panel.getByRole("button", { name: "Run again" })).toBeVisible({ timeout: 30_000 });

  await presenter.getByRole("button", { name: "Categories" }).first().click();
  await expect(presenter.getByRole("list", { name: "Categories" })).toBeVisible({ timeout: 30_000 });
  await expect(presenter.getByRole("list", { name: "Categories" }).getByRole("listitem").first()).toBeVisible();

  // Close the notes round, then run an open text round.
  await page.getByRole("listitem").filter({ hasText: "What should we improve?" }).getByRole("button", { name: "Close" }).click();
  await addInteraction(page, "New open text", "Any other thoughts?", "Save open text");
  await startOnly(page, "Any other thoughts?");
  await one.page.getByLabel("Your response").fill("Great event");
  await one.page.getByRole("button", { name: "Send" }).click();
  await expect(one.page.getByText("Thanks, your response was sent.")).toBeVisible();
  await expect(presenter.getByRole("list", { name: "Responses" }).getByText("Great event")).toBeVisible();

  // Close it, then run a rating round.
  await page.getByRole("listitem").filter({ hasText: "Any other thoughts?" }).getByRole("button", { name: "Close" }).click();
  await addInteraction(page, "New rating", "Rate the day", "Save rating");
  await startOnly(page, "Rate the day");
  await two.page.getByLabel("4 stars").check();
  await two.page.getByRole("button", { name: "Send rating" }).click();
  await expect(two.page.getByText("Thanks, you rated this 4 out of 5.")).toBeVisible();

  await one.context.close();
  await two.context.close();
});
