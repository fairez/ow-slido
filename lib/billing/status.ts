import { getBillingProvider } from "./index";
import { getSubscriptionRow } from "./http";
import { BillingNotConfiguredError } from "./types";

export type BillingControls = {
  /** A billing provider is set up on this server, so checkout can start. */
  configured: boolean;
  /** The workspace has a customer at the current provider, so the portal can open. */
  portal: boolean;
  /** A paid subscription is still renewing, so it can be canceled. */
  cancel: boolean;
  /**
   * How a paid-to-paid change starts. Stripe checkout always makes a new subscription, so a live one is
   * changed in the portal; the mock provider's checkout replaces the subscription, so it stays checkout.
   */
  changeVia: "checkout" | "portal";
};

/** What the plan page may offer for this workspace's subscription. */
export async function getBillingControls(workspaceId: string): Promise<BillingControls> {
  let provider;
  try {
    provider = getBillingProvider();
  } catch (error) {
    if (error instanceof BillingNotConfiguredError) return { configured: false, portal: false, cancel: false, changeVia: "checkout" };
    throw error;
  }
  const row = await getSubscriptionRow(workspaceId);
  const sameProvider = row?.provider === provider.id;
  const portal = Boolean(sameProvider && row?.providerCustomerId);
  const cancel = Boolean(
    sameProvider && row && row.providerSubscriptionId && row.providerCustomerId && row.currentPeriodEnd && row.plan !== "free" && row.status !== "canceled",
  );
  return { configured: true, portal, cancel, changeVia: cancel && provider.id !== "mock" ? "portal" : "checkout" };
}
