import "server-only";
import { getDb } from "@/lib/db";
import { appAuth, type AppAuth } from "@/lib/operator-app";

/**
 * Helpers for the operator app's API (/api/app/*, docs/operator-app.md). Every route but sign-in needs
 * `Authorization: Bearer <token>`; answers are JSON, errors `{ error: "<message for the operator>" }`.
 */

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export const fail = (message: string, status = 400) => json({ error: message }, status);

/** Runs a handler for a signed-in operator, or answers 401. */
export async function withApp(request: Request, handler: (auth: AppAuth) => Promise<Response>) {
  const auth = await appAuth(getDb(), request.headers.get("authorization"));
  if (!auth) return fail("Please sign in again.", 401);
  return handler(auth);
}
