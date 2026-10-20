import { getBillingProvider, type PaidPlan } from "@/lib/billing";
import { billingErrorResponse } from "@/lib/billing/http";
import { denyUnlessVerified, requireMember } from "@/lib/auth/require-admin";
import { serverT } from "@/lib/i18n/server";

export async function POST(request: Request) {
  const auth = await requireMember(request, "billing.manage");
  if (!auth.ok) return auth.response;
  const unverified = denyUnlessVerified(request, auth.user);
  if (unverified) return unverified;

  const body = (await request.json().catch(() => null)) as { plan?: unknown; interval?: unknown } | null;
  const plan = body?.plan === "pro" || body?.plan === "team" ? (body.plan as PaidPlan) : null;
  const interval = body?.interval === "month" || body?.interval === "year" ? body.interval : null;
  if (!plan || !interval) return Response.json({ error: serverT(request, "api.billingInvalidPlan") }, { status: 400 });

  try {
    const origin = new URL(request.url).origin;
    const session = await getBillingProvider().createCheckout({
      workspaceId: auth.workspaceId,
      plan,
      interval,
      customerEmail: auth.user.email,
      successUrl: `${origin}/dashboard/plan?checkout=success`,
      cancelUrl: `${origin}/dashboard/plan?checkout=canceled`,
    });
    return Response.json({ url: session.url });
  } catch (error) {
    const response = billingErrorResponse(request, error);
    if (response) return response;
    throw error;
  }
}
