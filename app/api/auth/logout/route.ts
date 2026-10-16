import { isSecureRequest, sessionClearCookie } from "@/lib/auth/session";

export async function POST(request: Request) {
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": sessionClearCookie(isSecureRequest(request)) } },
  );
}
