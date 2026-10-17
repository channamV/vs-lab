import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { checkins, engineSessions, machines, operators } from "@/lib/db/schema";
import { isCheckinCurrent } from "@/lib/operators";

/**
 * Data for the PUBLIC check-in page (/checkin/<machine>), which operators open by scanning the
 * QR sticker without signing in. Return only what that page shows: the machine's name, unit number
 * and who is checked in. Everything else stays in src/lib/data.ts behind the admin session check.
 */
export async function getCheckinMachine(code: string) {
  await connection();
  const db = getDb();
  const [machine] = await db
    .select({ id: machines.id, code: machines.code, name: machines.name, unitNumber: machines.unitNumber })
    .from(machines)
    .where(eq(machines.code, code));
  if (!machine) return null;
  const [open] = await db
    .select({ checkin: checkins, operatorName: operators.name, linked: engineSessions })
    .from(checkins)
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .leftJoin(engineSessions, eq(engineSessions.id, checkins.engineSessionId))
    .where(and(eq(checkins.machineId, machine.id), isNull(checkins.endedAt)));
  const current =
    open && isCheckinCurrent(open.checkin, open.linked, Date.now())
      ? { operatorName: open.operatorName, startedAt: open.checkin.startedAt, engineRunning: open.linked !== null }
      : null;
  return { code: machine.code, name: machine.name, unitNumber: machine.unitNumber, current };
}
