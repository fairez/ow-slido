import { getAiConfig } from "./config";
import { AiError, type AiProvider, type ProviderRequest } from "./types";

const ENDPOINTS = {
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
} as const;

export const MAX_ATTEMPTS = 3;

export type HttpOptions = {
  /** Wait before retry n (0-based). Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number) {
  return 500 * 2 ** attempt;
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,60}$/;

/** `HTTP 401 invalid_api_key`: the status plus the provider's own error code, never the message text. */
async function httpReason(res: Response): Promise<string> {
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; type?: unknown } };
    const raw = body?.error?.code ?? body?.error?.type;
    if (typeof raw === "string" && SAFE_CODE.test(raw)) code = raw;
  } catch {
    // Not JSON: keep the status only.
  }
  return ["HTTP " + res.status, code].filter(Boolean).join(" ");
}

/** `network ENOTFOUND`: the Node error code when there is one, so DNS, refused and timeout are told apart. */
function networkReason(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const raw = e?.cause?.code ?? e?.code;
  return typeof raw === "string" && /^[A-Z0-9_]{3,40}$/.test(raw) ? `network ${raw}` : "network";
}

function createHttpProvider(
  name: "openai" | "openrouter",
  model: string,
  apiKey: string,
  options: HttpOptions,
): AiProvider {
  const sleep = options.sleep ?? defaultSleep;
  return {
    name,
    model,
    async chat({ messages, signal }: ProviderRequest) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let res: Response;
        try {
          res = await fetch(ENDPOINTS[name], {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, response_format: { type: "json_object" } }),
            signal,
          });
        } catch (err) {
          if (signal.aborted) throw new AiError("timeout", "The AI request timed out");
          // Network failures are retried like 5xx; the cause is dropped so it cannot leak request data.
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(backoffMs(attempt));
            continue;
          }
          throw new AiError("provider", "Could not reach the AI provider", networkReason(err));
        }

        if (res.status === 429 || res.status >= 500) {
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(backoffMs(attempt));
            continue;
          }
          const reason = await httpReason(res);
          throw new AiError("provider", `The AI provider is unavailable (${reason})`, reason);
        }
        if (!res.ok) {
          const reason = await httpReason(res);
          throw new AiError("provider", `The AI provider rejected the request (${reason})`, reason);
        }

        const body = (await res.json().catch(() => null)) as {
          choices?: { message?: { content?: unknown } }[];
        } | null;
        const content = body?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new AiError("provider", "The AI provider returned an empty reply");
        return content;
      }
      throw new AiError("provider", "The AI provider is unavailable");
    },
  };
}

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  minItems?: number;
};

/** Builds a small valid value from a JSON schema: the same input always gives the same output. */
export function sampleFromSchema(schema: JsonSchema): unknown {
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, value]) => [key, sampleFromSchema(value)]),
      );
    case "array":
      return schema.items ? Array.from({ length: Math.max(1, schema.minItems ?? 1) }, () => sampleFromSchema(schema.items!)) : [];
    case "integer":
    case "number":
      return schema.minimum ?? 1;
    case "boolean":
      return true;
    default:
      return "mock";
  }
}

export function createMockProvider(model = "mock"): AiProvider {
  return {
    name: "mock",
    model,
    async chat({ jsonSchema }) {
      return JSON.stringify(sampleFromSchema(jsonSchema as JsonSchema));
    },
  };
}

/** Null when no provider is configured (or the key is missing). */
export function createProvider(options: HttpOptions = {}): AiProvider | null {
  const { provider, model, apiKey } = getAiConfig();
  if (provider === "mock") return createMockProvider(model);
  if ((provider === "openai" || provider === "openrouter") && apiKey) {
    return createHttpProvider(provider, model, apiKey, options);
  }
  return null;
}
