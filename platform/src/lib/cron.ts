import { timingSafeEqual } from "node:crypto";

/**
 * For the scheduled jobs in /api/jobs/* (Vercel Cron, see vercel.json). Vercel sends
 * "Authorization: Bearer <CRON_SECRET>"; anything else is refused. Returns an error response, or null if allowed.
 */
export function refuseUnlessCron(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response("CRON_SECRET is not set", { status: 503 });
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
