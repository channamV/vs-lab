import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { checkins, devices, engineSessions, operators } from "@/lib/db/schema";
import { isCheckinCurrent } from "@/lib/operators";

/**
 * Data for the PUBLIC check-in page (/checkin/<machine>), which operators open by scanning the
 * QR sticker without signing in. Return only what that page shows: the machine's name and who is
 * checked in. Everything else stays in src/lib/data.ts behind the admin session check.
 */
export async function getCheckinMachine(deviceId: string) {
  await connection();
  const db = getDb();
  const [device] = await db
    .select({ id: devices.id, name: devices.name, organizationId: devices.organizationId })
    .from(devices)
    .where(eq(devices.id, deviceId));
  // Unclaimed machines (not assigned to an organization yet) aren't set up for check-in.
  if (!device?.organizationId) return null;
  const [open] = await db
    .select({ checkin: checkins, operatorName: operators.name, linked: engineSessions })
    .from(checkins)
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .leftJoin(engineSessions, eq(engineSessions.id, checkins.engineSessionId))
    .where(and(eq(checkins.deviceId, deviceId), isNull(checkins.endedAt)));
  const current =
    open && isCheckinCurrent(open.checkin, open.linked, Date.now())
      ? { operatorName: open.operatorName, startedAt: open.checkin.startedAt, engineRunning: open.linked !== null }
      : null;
  return { id: device.id, name: device.name, current };
}
