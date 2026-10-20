import { getBillingProvider, isMockProvider } from "@/lib/billing";
import { notConfiguredResponse } from "@/lib/billing/http";
import { requireMember } from "@/lib/auth/require-admin";
import { serverT } from "@/lib/i18n/server";

/** Where the mock provider's checkout link lands. It "pays" by sending a signed webhook to ourselves. */
export async function GET(request: Request) {
  try {
    const provider = getBillingProvider();
    if (!isMockProvider(provider)) return new Response(null, { status: 404 });

    const auth = await requireMember(request, "billing.manage");
    if (!auth.ok) return auth.response;

    const claims = provider.readCheckoutToken(new URL(request.url).searchParams.get("token") ?? "");
    if (!claims || claims.workspaceId !== auth.workspaceId) {
      return Response.json({ error: serverT(request, "api.billingCheckoutInvalid") }, { status: 400 });
    }
    await provider.completeCheckout(claims);
    return new Response(null, { status: 303, headers: { location: "/dashboard/plan?checkout=success" } });
  } catch (error) {
    const response = notConfiguredResponse(request, error);
    if (response) return response;
    throw error;
  }
}
