import { beforeEach } from "vitest";
import { getRateLimitStore } from "@/lib/rate-limit";

// Tests sign up many users from one fake IP; start every test with empty rate-limit windows.
beforeEach(async () => {
  await getRateLimitStore().reset();
});
