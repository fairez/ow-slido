import { aiStatus, complete, type AiSchema } from "@/lib/ai";
import { aiErrorResponse } from "@/lib/ai/http";
import { requireMember } from "@/lib/auth/require-admin";

const pingSchema: AiSchema<{ ok: boolean }> = {
  name: "ping",
  jsonSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  },
  parse(value) {
    const ok = (value as { ok?: unknown } | null)?.ok;
    return typeof ok === "boolean" ? { ok: true, value: { ok } } : { ok: false, error: "Expected {\"ok\": boolean}." };
  },
};

export async function POST(request: Request) {
  const auth = await requireMember(request, "insights.manage");
  if (!auth.ok) return auth.response;
  try {
    await complete([{ role: "user", content: 'Return {"ok": true}.' }], pingSchema, { kind: "test" });
    return Response.json({ ok: true, ...aiStatus() });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
