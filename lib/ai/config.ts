export type AiProviderName = "openai" | "openrouter" | "mock";

export type AiConfig = {
  provider: AiProviderName | null;
  model: string;
  apiKey: string | null;
  eventCallCap: number;
  dailyCallCap: number;
};

const DEFAULT_MODELS: Record<AiProviderName, string> = {
  openai: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini",
  mock: "mock",
};

export const DEFAULT_EVENT_CALL_CAP = 20;
export const DEFAULT_DAILY_CALL_CAP = 200;

function readCap(raw: string | undefined, fallback: number) {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Reads the environment on every call so tests can change it. Server-only: holds the API key. */
export function getAiConfig(): AiConfig {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  const provider = raw === "openai" || raw === "openrouter" || raw === "mock" ? raw : null;
  const keyVar = provider === "openai" ? "OPENAI_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : null;
  const apiKey = (keyVar && process.env[keyVar]?.trim()) || null;
  return {
    provider,
    model: process.env.AI_MODEL?.trim() || (provider ? DEFAULT_MODELS[provider] : ""),
    apiKey,
    eventCallCap: readCap(process.env.AI_EVENT_CALL_CAP, DEFAULT_EVENT_CALL_CAP),
    dailyCallCap: readCap(process.env.AI_DAILY_CALL_CAP, DEFAULT_DAILY_CALL_CAP),
  };
}

export function isAiConfigured(): boolean {
  const { provider, apiKey } = getAiConfig();
  return provider === "mock" || (provider !== null && apiKey !== null);
}
