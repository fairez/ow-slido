import { expect, test } from "@playwright/test";
import { verifyEmail } from "./verify-email";

test("owner upgrades through the mock checkout, then cancels", async ({ page }) => {
  await page.goto("/signup");
  const email = `owner-${Date.now()}@example.com`;
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/dashboard");
  await verifyEmail(email);

  await page.goto("/dashboard/plan");
  await expect(page.getByText("Free", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);

  await page.getByText("Yearly", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Yearly" })).toBeChecked();
  await expect(page.getByText("$120 a year")).toBeVisible();
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();

  await page.waitForURL("**/dashboard/plan?checkout=success");
  await expect(page.getByRole("status").filter({ hasText: "Your workspace is on Pro." })).toBeVisible();
  await expect(page.getByText(/^Renews \d{4}-\d{2}-\d{2}\.$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage billing" })).toBeVisible();

  await page.getByRole("button", { name: "Cancel subscription" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel Pro?" });
  await expect(dialog.getByText(/Pro stays available until \d{4}-\d{2}-\d{2}/)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel subscription" }).click();

  await expect(page.getByText(/^Canceled\. Pro stays until \d{4}-\d{2}-\d{2}\.$/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
});
