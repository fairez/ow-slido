import { randomBytes } from "node:crypto";
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

/**
 * Sign-up is limited to five per IP per hour, and every browser here reaches the server from the same
 * address. Each test gets its own made-up client address (the server reads `x-real-ip`), so the number
 * of tests that sign someone up does not matter.
 */
export const test = base.extend({
  context: async ({ context }, provide) => {
    const [a, b, c] = randomBytes(3);
    await context.setExtraHTTPHeaders({ "x-real-ip": `10.${a}.${b}.${c}` });
    await provide(context);
  },
});
