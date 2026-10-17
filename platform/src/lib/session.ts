import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/lib/db";
import type { Role } from "@/lib/db/schema";
import { authFromToken, hasRole, SESSION_COOKIE, type AuthContext } from "@/lib/auth";

/** The signed-in user for this request (looked up once per request), or null. */
export const getAuth = cache(async (): Promise<AuthContext | null> => {
  const store = await cookies();
  return authFromToken(getDb(), store.get(SESSION_COOKIE)?.value);
});

/**
 * For pages and server actions: the signed-in user, or a redirect to the sign-in page.
 * Every admin server action must call this itself: server actions can be posted to any route,
 * including the public ones, so the proxy alone doesn't protect them.
 */
export async function requireAuth(minimum: Role = "viewer"): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  if (!hasRole(auth, minimum)) throw new Error("You don't have permission to do that.");
  return auth;
}

/** Platform admins only. Anyone else gets "not found", so the page doesn't even admit it exists. */
export async function requirePlatformAdmin(): Promise<AuthContext> {
  const auth = await requireAuth();
  if (!auth.isPlatformAdmin) notFound();
  return auth;
}

/** For pages only some roles may see (e.g. Users for owners): "not found" for everyone else. */
export async function requireRoleForPage(minimum: Role): Promise<AuthContext> {
  const auth = await requireAuth();
  if (!hasRole(auth, minimum)) notFound();
  return auth;
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Only allow redirects within this site after signing in. */
export function safeNext(next: unknown): string {
  const value = String(next ?? "/");
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}
