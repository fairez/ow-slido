import { BillingPayloadError, BillingSignatureError, getBillingProvider, receiveWebhook } from "@/lib/billing";
import { billingErrorResponse } from "@/lib/billing/http";
import { serverT } from "@/lib/i18n/server";

/** Called by the payment provider, not by a browser: no session, the signature is the credential. */
export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    const result = await receiveWebhook(getBillingProvider(), rawBody, request.headers);
    return Response.json({ received: true, result });
  } catch (error) {
    if (error instanceof BillingSignatureError) {
      return Response.json({ error: serverT(request, "api.billingBadSignature") }, { status: 400 });
    }
    if (error instanceof BillingPayloadError) {
      return Response.json({ error: serverT(request, "api.invalidBody") }, { status: 400 });
    }
    const response = billingErrorResponse(request, error);
    if (response) return response;
    throw error;
  }
}
