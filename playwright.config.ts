import { config } from "dotenv";
import { defineConfig } from "@playwright/test";

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
    command: "npx tsx server.ts",
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    // The app under test runs against the test database, never the dev one.
    env: { PORT: String(port), NEXT_DIST_DIR: ".next-e2e", DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" },
  },
});
