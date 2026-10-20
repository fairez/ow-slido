import { eq } from "drizzle-orm";
import { subscriptions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";
import { BillingNotConfiguredError, BillingProviderError } from "./types";

/** 503 when billing is not set up, 502 when the provider refused or failed; null for anything else. */
export function billingErrorResponse(request: Request, error: unknown): Response | null {
  if (error instanceof BillingNotConfiguredError) {
    return Response.json({ error: serverT(request, "api.billingNotConfigured") }, { status: 503 });
  }
  if (error instanceof BillingProviderError) {
    return Response.json({ error: serverT(request, "api.billingProviderError") }, { status: 502 });
  }
  return null;
}

export async function getSubscriptionRow(workspaceId: string) {
  const [row] = await getDb().select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
  return row ?? null;
}
