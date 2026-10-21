import { expect, test } from "./fixtures";
import type { Browser, Page } from "@playwright/test";
import { setPlanFor, verifyEmail } from "./verify-email";

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** A verified Pro host with one running event. The interactions are made through the API; the screens are driven by hand. */
async function hostWithEvent(page: Page) {
  const email = `host-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/dashboard");
  await verifyEmail(email);
  await setPlanFor(email, "pro");
  const now = Date.now();
  await page.getByLabel("Event name").fill("Interactions e2e");
  await page.getByLabel("Start").fill(localInput(new Date(now - 3_600_000)));
  await page.getByLabel("End").fill(localInput(new Date(now + 3_600_000)));
  await page.getByRole("button", { name: "Create event" }).click();
  const code = (await page.getByRole("status").locator("strong").nth(1).innerText()).trim();
  await page.getByRole("link", { name: "Manage" }).click();
  await page.waitForURL("**/dashboard/events/*");
  const eventId = new URL(page.url()).pathname.split("/").pop()!;
  return { code, eventId };
}

async function createInteraction(page: Page, eventId: string, body: Record<string, unknown>) {
  const res = await page.request.post(`/api/events/${eventId}/interactions`, { data: body });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).interaction as { id: string; config: Record<string, unknown> };
}

async function act(page: Page, eventId: string, interactionId: string, action: "start" | "close") {
  const res = await page.request.post(`/api/events/${eventId}/interactions/${interactionId}/${action}`);
  expect(res.status(), await res.text()).toBe(200);
}

async function participant(browser: Browser, code: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/join/${code}`);
  await page.waitForURL("**/e/**");
  return { context, page };
}

test("a participant ranks the options and the presenter shows the ranking", async ({ browser, page }) => {
  const { code, eventId } = await hostWithEvent(page);
  const ranking = await createInteraction(page, eventId, { type: "ranking", prompt: "Rank the snacks", options: ["Apple", "Banana", "Cherry"] });
  await act(page, eventId, ranking.id, "start");

  const presenter = await page.context().newPage();
  await presenter.goto(`/present/${eventId}`);
  await expect(presenter.getByRole("heading", { name: "Rank the snacks" })).toBeVisible();

  const phone = await participant(browser, code);
  // Cherry to the top: up twice. Cherry gets 3 points, Apple 2, Banana 1.
  const up = phone.page.getByRole("button", { name: /^Move Cherry up/ });
  await up.click();
  await up.click();
  await phone.page.getByRole("button", { name: "Send ranking" }).click();
  await expect(phone.page.getByText("Answer sent")).toBeVisible();

  const list = presenter.getByRole("list", { name: "Options ranked by score" });
  await expect(presenter.getByText("1 ranking submitted")).toBeVisible();
  await expect(list.getByRole("listitem").first()).toContainText("#1");
  await expect(list.getByRole("listitem").first()).toContainText("Cherry");
  await expect(list.getByRole("listitem").first()).toContainText("3 points");

  // Reloading the phone keeps the answer.
  await phone.page.reload();
  await expect(phone.page.getByText("Answer sent")).toBeVisible();
  await phone.context.close();
});

test("a quiz question scores the answers and the presenter shows the leaderboard", async ({ browser, page }) => {
  const { code, eventId } = await hostWithEvent(page);
  const quiz = await createInteraction(page, eventId, {
    type: "quiz",
    title: "Capital of France",
    prompt: "Capital of France?",
    options: [
      { id: "paris", text: "Paris" },
      { id: "rome", text: "Rome" },
    ],
    correctOptionIds: ["paris"],
    timeLimitSeconds: 60,
    points: 1000,
  });
  await act(page, eventId, quiz.id, "start");

  const presenter = await page.context().newPage();
  await presenter.goto(`/present/${eventId}`);
  await expect(presenter.getByRole("heading", { name: "Capital of France" })).toBeVisible();

  const play = async (nickname: string, answer: string) => {
    const phone = await participant(browser, code);
    await phone.page.getByLabel("Nickname").fill(nickname);
    await phone.page.getByRole("button", { name: "Save nickname" }).click();
    await expect(phone.page.getByText(`Playing as ${nickname}`)).toBeVisible();
    await phone.page.getByRole("button", { name: answer }).click();
    await expect(phone.page.getByText(/Answer sent/)).toBeVisible();
    return phone;
  };
  const ada = await play("Ada", "Paris");
  const bob = await play("Bob", "Rome");
  await expect(presenter.getByText("2 answers")).toBeVisible();

  // Closing reveals the answer and the standings.
  await presenter.getByRole("button", { name: "Close and show answer" }).click();
  const board = presenter.getByRole("list", { name: "Leaderboard, best first" });
  await expect(board.getByRole("listitem")).toHaveCount(2);
  await expect(board.getByRole("listitem").first()).toContainText("Ada");
  await expect(board.getByRole("listitem").last()).toContainText("Bob");
  await expect(ada.page.getByText("Rank 1 of 2")).toBeVisible();
  await expect(bob.page.getByText("Rank 2 of 2")).toBeVisible();
  await expect(bob.page.getByText("Not this time")).toBeVisible();

  await presenter.getByRole("button", { name: "End quiz and show podium" }).click();
  await expect(presenter.getByRole("heading", { name: "Final podium" })).toBeVisible();
  await expect(presenter.getByRole("list", { name: "Top three, best first" })).toContainText("Ada");
  await ada.context.close();
  await bob.context.close();
});

test("a survey takes one submission per person and the host sees the results", async ({ browser, page }) => {
  const { eventId } = await hostWithEvent(page);
  const survey = await createInteraction(page, eventId, {
    type: "survey",
    title: "Event feedback",
    questions: [
      { kind: "choice", text: "Which session was best?", required: true, options: ["Keynote", "Workshop"] },
      { kind: "rating", text: "How was the venue?", scale: "stars5" },
      { kind: "openText", text: "Anything else?" },
    ],
  });
  await act(page, eventId, survey.id, "start");

  const context = await browser.newContext();
  const phone = await context.newPage();
  await phone.goto(`/survey/${survey.id}`);
  await expect(phone.getByRole("heading", { name: "Event feedback" })).toBeVisible();

  // A required question left empty blocks the send.
  await phone.getByRole("button", { name: "Send answers" }).click();
  await expect(phone.getByText("1 required question has no answer.")).toBeVisible();

  await phone.getByLabel("Workshop").check();
  await phone.getByRole("textbox", { name: /Your answer to question 3/ }).fill("More coffee");
  await phone.getByRole("button", { name: "Send answers" }).click();
  await expect(phone.getByText("Thank you")).toBeVisible();

  // A second try from the same phone: the page says so, and the API refuses a second set.
  await phone.reload();
  await expect(phone.getByText("Already submitted")).toBeVisible();
  const first = (survey.config.questions as { id: string; options: { id: string }[] }[])[0];
  const again = await context.request.post(`/api/interactions/${survey.id}/survey`, {
    data: { answers: { [first.id]: [first.options[0].id] } },
  });
  expect(again.status()).toBe(409);
  expect((await again.json()).reason).toBe("alreadySubmitted");

  // The host's library counts one response and the results screen prints it.
  await page.reload();
  const row = page.getByRole("listitem").filter({ hasText: "Event feedback" });
  await expect(row).toContainText("1 response");
  const presenter = await page.context().newPage();
  await presenter.goto(`/present/${eventId}?view=survey&survey=${survey.id}`);
  await expect(presenter.getByRole("heading", { level: 1, name: "Event feedback" })).toBeVisible();
  await expect(presenter.getByText(/1 response · 0 completed/)).toBeVisible();
  await expect(presenter.getByRole("progressbar", { name: "Workshop" })).toHaveAttribute("aria-valuetext", "1 vote, 100%");
  await expect(presenter.getByText("More coffee")).toBeVisible();
  await context.close();
});
