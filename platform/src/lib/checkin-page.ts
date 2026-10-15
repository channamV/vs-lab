import "server-only";
import { and, eq, gte, isNull } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { checkins, devices, operators } from "@/lib/db/schema";
import { CHECKIN_RULES } from "@/lib/operators";

/**
 * Data for the PUBLIC check-in page (/checkin/<machine>), which operators open by scanning the
 * QR sticker without signing in. Return only what that page shows: the machine's name and who is
 * checked in. Everything else stays in src/lib/data.ts behind the admin session check.
 */
export async function getCheckinMachine(deviceId: string) {
  await connection();
  const db = getDb();
  const [device] = await db.select({ id: devices.id, name: devices.name }).from(devices).where(eq(devices.id, deviceId));
  if (!device) return null;
  const since = new Date(Date.now() - CHECKIN_RULES.maxHours * 3_600_000);
  const [current] = await db
    .select({ operatorName: operators.name, startedAt: checkins.startedAt })
    .from(checkins)
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .where(and(eq(checkins.deviceId, deviceId), isNull(checkins.endedAt), gte(checkins.startedAt, since)));
  return { ...device, current: current ?? null };
}
