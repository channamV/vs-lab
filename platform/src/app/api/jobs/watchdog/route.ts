import { runWatchdog } from "@/lib/alert-jobs";
import { refuseUnlessCron } from "@/lib/cron";

/** The tamper watchdog, called every 5 minutes by Vercel Cron (vercel.json). Not behind the sign-in proxy. */
export async function GET(request: Request) {
  return refuseUnlessCron(request) ?? Response.json(await runWatchdog());
}
