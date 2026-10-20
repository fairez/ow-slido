import { beforeEach } from "vitest";
import { getRateLimitStore } from "@/lib/rate-limit";

// Failed background jobs are retried with backoff; tests do not wait for it.
process.env.JOB_RETRY_BACKOFF_MS = "0,0,0";

// Tests sign up many users from one fake IP; start every test with empty rate-limit windows.
beforeEach(async () => {
  await getRateLimitStore().reset();
});
