import { getDb } from "@/lib/db";
import { processEvents } from "@/lib/notifications";
import { checkPostedSpeeds } from "@/lib/posted-speed";
import { refuseUnlessCron } from "@/lib/cron";

/** Posted speed limits, every 5 minutes (Vercel Cron, vercel.json). Map downloads can be slow, hence its own job. */
export const maxDuration = 120;

export async function GET(request: Request) {
  const refused = refuseUnlessCron(request);
  if (refused) return refused;
  const db = getDb();
  const recorded = await checkPostedSpeeds(db);
  await processEvents(db, {});
  return Response.json({ recorded });
}
