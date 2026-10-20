import { expect, test, type Browser, type Page } from "@playwright/test";

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

async function createEvent(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(`host-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/dashboard");
  const now = Date.now();
  await page.getByLabel("Event name").fill("Q&A e2e");
  await page.getByLabel("Start").fill(localInput(new Date(now - 3_600_000)));
  await page.getByLabel("End").fill(localInput(new Date(now + 3_600_000)));
  await page.getByRole("button", { name: "Create event" }).click();
  const code = (await page.getByRole("status").locator("strong").nth(1).innerText()).trim();
  await page.getByRole("link", { name: "Manage" }).click();
  return code;
}

async function ask(browser: Browser, code: string, text: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/join/${code}`);
  await page.waitForURL("**/e/**");
  await page.getByRole("tab", { name: "Q&A" }).click();
  await page.getByLabel("Your question").fill(text);
  await page.getByRole("button", { name: /Send|Ask|Submit/ }).first().click();
  return { context, page };
}

test("the presenter can show the Q&A screen; waiting questions stay hidden until approved", async ({ browser, page }) => {
  const code = await createEvent(page);
  const presenterHref = (await page.getByRole("link", { name: "Open presenter view" }).getAttribute("href"))!;

  const presenter = await page.context().newPage();
  await presenter.goto(presenterHref);
  await expect(presenter.getByText("No live interaction")).toBeVisible();
  await presenter.getByRole("button", { name: /Show Q&A/ }).click();
  await expect(presenter.getByRole("heading", { name: "Q&A" })).toBeVisible();
  await expect(presenter.getByText(/No questions yet/)).toBeVisible();
  expect(new URL(presenter.url()).searchParams.get("view")).toBe("qa");

  // Open mode: a new question shows up on the projector without a refresh.
  const first = await ask(browser, code, "When does the next session start?");
  await expect(presenter.getByRole("list", { name: "Questions" }).getByText("When does the next session start?")).toBeVisible();

  // Moderated mode: a waiting question never reaches the screen until the host approves it.
  const modHref = (await page.getByRole("link", { name: "Open moderation queue" }).getAttribute("href"))!;
  const modPage = await page.context().newPage();
  await modPage.goto(modHref);
  const moderated = modPage.getByLabel("Moderated Q&A (questions need approval)");
  await moderated.click(); // the box changes once the server has confirmed
  await expect(moderated).toBeChecked();
  await expect(modPage.getByText("Mode: Moderated")).toBeVisible();
  const second = await ask(browser, code, "Is the recording shared?");
  await expect(modPage.getByRole("heading", { name: "Pending (1)" })).toBeVisible();
  await expect(presenter.getByText("Is the recording shared?")).toHaveCount(0);
  await modPage.getByRole("button", { name: "Approve" }).first().click();
  await expect(presenter.getByText("Is the recording shared?")).toBeVisible();

  // The screen survives a reload, and the Q key goes back to the interaction view.
  await presenter.reload();
  await expect(presenter.getByRole("heading", { name: "Q&A" })).toBeVisible();
  await presenter.keyboard.press("q");
  await expect(presenter.getByText("No live interaction")).toBeVisible();

  await first.context.close();
  await second.context.close();
});
