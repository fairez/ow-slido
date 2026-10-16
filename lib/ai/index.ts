import { getAiConfig, isAiConfigured } from "./config";
import { createProvider, type HttpOptions } from "./providers";
import { AiError, type AiMessage, type AiProvider, type AiSchema } from "./types";
import { reserveAiCall } from "./usage";

export { getAiConfig, isAiConfigured } from "./config";
export { AiError } from "./types";
export type { AiMessage, AiSchema, AiErrorCode } from "./types";

export const AI_TIMEOUT_MS = 30_000;

export type CompleteOptions = {
  /** Event the call is billed to; null for platform-level calls such as the admin test. */
  eventId?: string | null;
  kind?: string;
  timeoutMs?: number;
  /** Override for tests. */
  provider?: AiProvider;
  http?: HttpOptions;
};

function parseJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(text);
}

async function ask(provider: AiProvider, messages: AiMessage[], schema: AiSchema<unknown>, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await provider.chat({ messages, jsonSchema: schema.jsonSchema, signal: controller.signal });
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (controller.signal.aborted) throw new AiError("timeout", "The AI request timed out");
    throw new AiError("provider", "The AI provider failed");
  } finally {
    clearTimeout(timer);
  }
}

function check<T>(raw: string, schema: AiSchema<T>): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = parseJson(raw);
  } catch {
    return { ok: false, error: "The reply was not valid JSON." };
  }
  return schema.parse(json);
}

/**
 * Sends the messages to the configured provider and returns output that passed `schema.parse`.
 * Counts one call against the event and daily caps. If the first reply fails validation the model
 * gets one chance to repair it. Neither the key nor the messages are logged or put in errors.
 */
export async function complete<T>(
  messages: AiMessage[],
  schema: AiSchema<T>,
  options: CompleteOptions = {},
): Promise<T> {
  const provider = options.provider ?? createProvider(options.http);
  if (!provider) throw new AiError("not_configured", "AI is not configured on this server.");

  await reserveAiCall({
    eventId: options.eventId ?? null,
    kind: options.kind ?? "complete",
    provider: provider.name,
    model: provider.model,
  });

  const timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
  const withSchema: AiMessage[] = [
    {
      role: "system",
      content: `Reply with a single JSON object that matches this JSON schema and nothing else:\n${JSON.stringify(schema.jsonSchema)}`,
    },
    ...messages,
  ];

  const first = await ask(provider, withSchema, schema, timeoutMs);
  const firstResult = check(first, schema);
  if (firstResult.ok) return firstResult.value;

  const repaired = await ask(
    provider,
    [
      ...withSchema,
      { role: "assistant", content: first },
      {
        role: "user",
        content: `That reply was rejected: ${firstResult.error} Reply again with only the corrected JSON object.`,
      },
    ],
    schema,
    timeoutMs,
  );
  const secondResult = check(repaired, schema);
  if (secondResult.ok) return secondResult.value;
  throw new AiError("invalid_output", "The AI returned a reply that could not be used.");
}

export function aiStatus() {
  const { provider, model } = getAiConfig();
  return { provider, model: provider ? model : null, configured: isAiConfigured() };
}
