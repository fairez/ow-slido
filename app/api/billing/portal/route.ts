import { getBillingProvider } from "@/lib/billing";
import { getSubscriptionRow, billingErrorResponse } from "@/lib/billing/http";
import { requireMember } from "@/lib/auth/require-admin";
import { serverT } from "@/lib/i18n/server";

export async function POST(request: Request) {
  const auth = await requireMember(request, "billing.manage");
  if (!auth.ok) return auth.response;

  try {
    const provider = getBillingProvider();
    const row = await getSubscriptionRow(auth.workspaceId);
    if (!row?.providerCustomerId || row.provider !== provider.id) {
      return Response.json({ error: serverT(request, "api.billingNoSubscription") }, { status: 409 });
    }
    const session = await provider.createPortalSession({
      workspaceId: auth.workspaceId,
      providerCustomerId: row.providerCustomerId,
      returnUrl: `${new URL(request.url).origin}/dashboard/plan`,
    });
    return Response.json({ url: session.url });
  } catch (error) {
    const response = billingErrorResponse(request, error);
    if (response) return response;
    throw error;
  }
}
