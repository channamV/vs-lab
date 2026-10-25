import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { appTimeZone } from "@/lib/telemetry/engine";

/**
 * A company's time zone (Settings → time zone): times written into alerts and notifications, and the days that
 * daily totals and limits count, are in it. Falls back to the server default (APP_TIMEZONE) if not found.
 */
export async function orgTimeZone(db: Db, organizationId: number): Promise<string> {
  const [org] = await db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, organizationId));
  return org?.tz || appTimeZone();
}

/** The same, remembered for the length of a job that goes through many machines. */
export function orgTimeZones(db: Db) {
  const seen = new Map<number, Promise<string>>();
  return (organizationId: number) => {
    if (!seen.has(organizationId)) seen.set(organizationId, orgTimeZone(db, organizationId));
    return seen.get(organizationId)!;
  };
}
