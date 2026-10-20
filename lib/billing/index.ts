import { MockBillingProvider } from "./mock";
import { StripeProvider } from "./stripe";
import { BillingNotConfiguredError, type BillingProvider } from "./types";

export * from "./types";
export { receiveWebhook, applyBillingEvent } from "./webhook";

/**
 * `BILLING_PROVIDER=mock` or `stripe`. Unset means mock outside production and no billing in production,
 * so a deploy without payment settings cannot hand out paid plans.
 */
export function getBillingProvider(): BillingProvider {
  const name = process.env.BILLING_PROVIDER || (process.env.NODE_ENV === "production" ? "" : "mock");
  if (name === "mock") return new MockBillingProvider();
  if (name === "stripe") return new StripeProvider();
  throw new BillingNotConfiguredError(name ? `Billing provider "${name}" is not available` : "BILLING_PROVIDER is not set");
}

export function isMockProvider(provider: BillingProvider): provider is MockBillingProvider {
  return provider instanceof MockBillingProvider;
}
