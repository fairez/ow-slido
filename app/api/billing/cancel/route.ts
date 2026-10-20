import { getBillingProvider } from "@/lib/billing";
import { getSubscriptionRow, notConfiguredResponse } from "@/lib/billing/http";
import { requireMember } from "@/lib/auth/require-admin";
import { serverT } from "@/lib/i18n/server";

/** Stops renewal. Access stays until the period end; the state change arrives as a webhook. */
export async function POST(request: Request) {
  const auth = await requireMember(request, "billing.manage");
  if (!auth.ok) return auth.response;

  try {
    const provider = getBillingProvider();
    const row = await getSubscriptionRow(auth.workspaceId);
    if (
      !row ||
      row.provider !== provider.id ||
      !row.providerSubscriptionId ||
      !row.providerCustomerId ||
      !row.currentPeriodEnd ||
      row.plan === "free" ||
      row.status === "canceled"
    ) {
      return Response.json({ error: serverT(request, "api.billingNoSubscription") }, { status: 409 });
    }
    await provider.cancelSubscription({
      workspaceId: auth.workspaceId,
      providerSubscriptionId: row.providerSubscriptionId,
      providerCustomerId: row.providerCustomerId,
      plan: row.plan,
      interval: row.interval,
      currentPeriodEnd: row.currentPeriodEnd,
    });
    return Response.json({ ok: true });
  } catch (error) {
    const response = notConfiguredResponse(request, error);
    if (response) return response;
    throw error;
  }
}
