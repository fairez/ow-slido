import { NextResponse, type NextRequest } from "next/server";

/**
 * Hands the path of an audience page to the layout, which cannot see route params: the header and `<html lang>`
 * must follow the event's audience language, not the host's.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-audience-path", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/join/:path*", "/e/:path*", "/present/:path*", "/survey/:path*"] };
