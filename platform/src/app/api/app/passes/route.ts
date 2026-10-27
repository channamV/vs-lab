import { getDb } from "@/lib/db";
import { json, withApp } from "@/lib/app-api";
import { appSessions, offlinePasses } from "@/lib/operator-app";

/**
 * GET: passes to start Safety & Access Control machines without signal, and the operator's held check-ins (session
 * hold: resume after a break with the phone). Refreshed while the phone has signal.
 */
export async function GET(request: Request) {
  return withApp(request, async (auth) => {
    const db = getDb();
    return json({ passes: await offlinePasses(db, auth), sessions: await appSessions(db, auth) });
  });
}
