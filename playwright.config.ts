import { config } from "dotenv";
import { defineConfig } from "@playwright/test";
import { OUTBOX_FILE } from "./e2e/outbox";

config({ path: ".env.local" });

const port = 3100;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${port}`,
    // Set PW_CHROMIUM_PATH when the Chromium build Playwright expects is not installed.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    // A production build: `next dev` compiles each route on first request, which is slower than the
    // 5s waits in the tests on a small machine and made the runs flaky.
    command: "npx next build && npx tsx server.ts",
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 300_000,
    // The app under test runs against the test database, never the dev one.
    env: {
      PORT: String(port),
      NODE_ENV: "production",
      NEXT_DIST_DIR: ".next-e2e",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      // Deterministic fake: the e2e run never reaches a real AI service.
      AI_PROVIDER: "mock",
      // Billing never leaves the machine: checkout completes through a local route.
      BILLING_PROVIDER: "mock",
      BILLING_WEBHOOK_SECRET: "e2e-webhook-secret",
      // Mail stays in the log adapter; each message is also appended to a file the tests read.
      EMAIL_PROVIDER: "log",
      EMAIL_OUTBOX_FILE: OUTBOX_FILE,
      // Throwaway key so 2FA can be turned on; it protects nothing outside the test database.
      TWOFA_ENCRYPTION_KEY: "e".repeat(64),
      // The one address the suspend flow treats as a platform operator (see e2e/phase3.spec.ts).
      OPERATOR_EMAILS: "e2e-operator@example.com",
    },
  },
});
