import { getDb } from "@/lib/db";
import { json, withApp } from "@/lib/app-api";
import { offlinePasses } from "@/lib/operator-app";

/** GET: passes to start Safety & Access Control machines without signal (refreshed while the phone has signal). */
export async function GET(request: Request) {
  return withApp(request, async (auth) => json({ passes: await offlinePasses(getDb(), auth) }));
}
