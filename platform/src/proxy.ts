import { NextResponse, type NextRequest } from "next/server";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";

/**
 * Sends signed-out visitors to /login. Excluded by the matcher: device endpoints (/hub/api),
 * the operator check-in pages (/checkin/<machine>, opened from the QR sticker) and static files.
 */
export async function proxy(request: NextRequest) {
  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const url = new URL("/login", request.url);
  url.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!hub/api|login|checkin/|_next/static|_next/image|favicon.ico).*)"],
};
