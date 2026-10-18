/** What a provider failure usually means and what the admin can do about it, from AiError.reason. */
export function providerHint(reason: string | undefined): string {
  if (!reason) return "";
  const r = reason.toLowerCase();
  if (r.includes("insufficient_quota") || r.includes("billing")) return "The AI account has no credit left. Add credit with the provider.";
  if (r.includes("invalid_api_key") || r.includes("http 401") || r.includes("http 403")) return "The AI key was rejected. Check the API key set on the server.";
  if (r.includes("model_not_found") || r.includes("http 404")) return "The AI model was not found. Check AI_MODEL on the server.";
  if (r.includes("rate_limit") || r.includes("http 429")) return "The AI service is rate limiting this account. Try again in a minute.";
  if (r.includes("http 5")) return "The AI service reported an error. Try again in a minute.";
  if (r.startsWith("network")) return "This server could not connect to the AI service.";
  return "";
}
