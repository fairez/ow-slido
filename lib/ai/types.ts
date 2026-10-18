export type AiMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiParse<T> = { ok: true; value: T } | { ok: false; error: string };

/** What the model must return: a JSON schema to describe it and a parser that checks it. */
export type AiSchema<T> = {
  name: string;
  jsonSchema: Record<string, unknown>;
  parse: (value: unknown) => AiParse<T>;
};

export type AiErrorCode =
  | "not_configured"
  | "event_cap"
  | "daily_cap"
  | "timeout"
  | "provider"
  | "invalid_output";

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    /** Short, safe cause for the host and the server log (`HTTP 401 invalid_api_key`, `network ENOTFOUND`). Never request or reply text. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export type ProviderRequest = {
  messages: AiMessage[];
  jsonSchema: Record<string, unknown>;
  signal: AbortSignal;
};

/** Returns the raw text of the model's reply. */
export interface AiProvider {
  readonly name: "openai" | "openrouter" | "mock";
  readonly model: string;
  chat(request: ProviderRequest): Promise<string>;
}
