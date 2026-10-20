import { getDb } from "@/lib/db";
import { refuseUnlessCron } from "@/lib/cron";
import { applyRetention } from "@/lib/privacy";

/**
 * The nightly privacy clean-up (each organization's retention settings), called once a day by Vercel
 * Cron (vercel.json). Not behind the sign-in proxy.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  return refuseUnlessCron(request) ?? Response.json(await applyRetention(getDb()));
}
