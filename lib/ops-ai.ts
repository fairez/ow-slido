import { getAiConfig, isAiConfigured } from "@/lib/ai/config";
import { countAiCallsToday } from "@/lib/ai/usage";
import { getDb } from "@/lib/db";

export type OpsAiStatus = {
  provider: "openai" | "openrouter" | "mock" | null;
  model: string | null;
  configured: boolean;
  /** AI calls so far today (UTC), all workspaces. */
  callsToday: number;
  globalDailyCap: number;
  paused: boolean;
};

/** What the operator console shows about AI. Names and counts only: never the key or where it comes from. */
export async function getOpsAiStatus(db: Pick<ReturnType<typeof getDb>, "select"> = getDb(), now: Date = new Date()): Promise<OpsAiStatus> {
  const { provider, model, globalDailyCap } = getAiConfig();
  const callsToday = await countAiCallsToday(db, now);
  return {
    provider,
    model: provider ? model : null,
    configured: isAiConfigured(),
    callsToday,
    globalDailyCap,
    paused: callsToday >= globalDailyCap,
  };
}
