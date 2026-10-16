import { AiError } from "./types";

const STATUS: Record<AiError["code"], number> = {
  not_configured: 503,
  event_cap: 429,
  daily_cap: 429,
  timeout: 504,
  provider: 502,
  invalid_output: 502,
};

export function aiErrorResponse(err: unknown): Response {
  if (err instanceof AiError) {
    return Response.json({ error: err.message, code: err.code }, { status: STATUS[err.code] });
  }
  throw err;
}
