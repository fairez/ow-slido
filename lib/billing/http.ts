import { eq } from "drizzle-orm";
import { subscriptions } from "@/db/schema";
import { getDb } from "@/lib/db";
import { serverT } from "@/lib/i18n/server";
import { BillingNotConfiguredError } from "./types";

export function notConfiguredResponse(request: Request, error: unknown): Response | null {
  if (!(error instanceof BillingNotConfiguredError)) return null;
  return Response.json({ error: serverT(request, "api.billingNotConfigured") }, { status: 503 });
}

export async function getSubscriptionRow(workspaceId: string) {
  const [row] = await getDb().select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
  return row ?? null;
}
