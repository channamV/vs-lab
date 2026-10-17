import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

/**
 * First gate: sends visitors without a sign-in cookie to /login. The cookie itself is checked against
 * the database by every page and action (src/lib/session.ts), so a fake cookie gets nothing.
 * Excluded by the matcher: device endpoints (/hub/api), the operator check-in pages
 * (/checkin/<machine>, opened from the QR sticker), sign-in pages and static files.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  const url = new URL("/login", request.url);
  url.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!hub/api|login|checkin/|_next/static|_next/image|favicon.ico).*)"],
};
