import { runScheduleJob } from "@/lib/alert-jobs";
import { refuseUnlessCron } from "@/lib/cron";

/** Schedules (mode changes, temporary access, reminders, late changes), called every minute by Vercel Cron (vercel.json). */
export async function GET(request: Request) {
  return refuseUnlessCron(request) ?? Response.json(await runScheduleJob());
}
