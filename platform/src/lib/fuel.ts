import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { alerts, engineSessions, machines, telemetry, type Alert } from "@/lib/db/schema";
import { clockTime, formatHours, machineLabel } from "@/lib/format";
import { appTimeZone } from "@/lib/telemetry/engine";

/**
 * Fuel theft: the tank level when the engine starts is lower than it was when the engine last stopped.
 * Fuel level is only reported while the ignition is on (from the engine computer: J1939 SPN 96, or OBD-II
 * PID 2F), so the comparison is "last readings before the stop" vs "first readings after the start, once
 * the level has settled". Medians of several readings smooth out fuel slosh and sensor noise. One check
 * per engine start. See docs/alerts.md.
 */
export const FUEL_RULES = {
  /** A drop of at least this much of the tank between stop and start raises the alert... */
  minDropPct: 5,
  /** ...and, when the tank size is known, at least this many litres. */
  minDropLitres: 20,
  /** Wait this long after a start for the level to settle before comparing. */
  settleMinutes: 2,
  /** Readings each side used for the median. */
  readings: 5,
  /** Give up on a start that hasn't sent enough fuel readings after this long. */
  giveUpMinutes: 15,
  /** Only compare with a stop within this many days. */
  lookbackDays: 14,
};

const FUEL_LEVEL = sql<number>`coalesce(${telemetry.fields}->>'j1939FuelLevelPct', ${telemetry.fields}->>'obdFuelLevelPct')::float`;
const HAS_FUEL_LEVEL = sql`(${telemetry.fields} ? 'j1939FuelLevelPct' or ${telemetry.fields} ? 'obdFuelLevelPct')`;

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Checks the machine's current engine-on period once its fuel level has settled, and raises a
 * "Possible fuel theft" alert if the tank lost fuel while the engine was off. Every machine with fuel
 * level data is checked, whatever its service level (it's a theft alert). Returns new alerts.
 */
export async function checkFuelTheft(db: Db, machineId: number, now = new Date()): Promise<Alert[]> {
  const [session] = await db
    .select()
    .from(engineSessions)
    .where(and(eq(engineSessions.machineId, machineId), isNull(engineSessions.endedAt), isNull(engineSessions.fuelCheckedAt)));
  if (!session) return [];
  const runningMs = now.getTime() - session.startedAt.getTime();
  if (runningMs < FUEL_RULES.settleMinutes * 60_000) return [];

  const done = (fuelStartPct: number | null) =>
    db.update(engineSessions).set({ fuelStartPct, fuelCheckedAt: now }).where(eq(engineSessions.id, session.id));

  const after = await db
    .select({ level: FUEL_LEVEL })
    .from(telemetry)
    .where(and(eq(telemetry.machineId, machineId), eq(telemetry.engineOn, true), gte(telemetry.receivedAt, session.startedAt), HAS_FUEL_LEVEL))
    .orderBy(telemetry.receivedAt, telemetry.id)
    .limit(FUEL_RULES.readings);
  if (after.length < Math.min(3, FUEL_RULES.readings)) {
    if (runningMs > FUEL_RULES.giveUpMinutes * 60_000) await done(null); // no fuel data on this machine / start
    return [];
  }
  const before = await db
    .select({ level: FUEL_LEVEL, at: telemetry.receivedAt })
    .from(telemetry)
    .where(
      and(
        eq(telemetry.machineId, machineId),
        eq(telemetry.engineOn, true),
        lt(telemetry.receivedAt, session.startedAt),
        gte(telemetry.receivedAt, new Date(session.startedAt.getTime() - FUEL_RULES.lookbackDays * 86_400_000)),
        HAS_FUEL_LEVEL,
      ),
    )
    .orderBy(desc(telemetry.receivedAt), desc(telemetry.id))
    .limit(FUEL_RULES.readings);
  const startPct = median(after.map((r) => Number(r.level)));
  await done(startPct);
  if (before.length === 0) return [];

  const stopPct = median(before.map((r) => Number(r.level)));
  const dropPct = stopPct - startPct;
  const [machine] = await db.select().from(machines).where(eq(machines.id, machineId));
  if (!machine) return [];
  const litres = machine.fuelTankLitres ? (dropPct / 100) * machine.fuelTankLitres : null;
  if (dropPct < FUEL_RULES.minDropPct || (litres !== null && litres < FUEL_RULES.minDropLitres)) return [];

  const tz = appTimeZone();
  const stoppedAt = before[0].at;
  const parked = (session.startedAt.getTime() - stoppedAt.getTime()) / 3_600_000;
  return db
    .insert(alerts)
    .values({
      organizationId: machine.organizationId,
      machineId,
      type: "fuel-theft",
      engineSessionId: session.id,
      createdAt: now,
      title: `Possible fuel theft: ${machineLabel(machine)}`,
      detail:
        `The fuel level dropped from ${Math.round(stopPct)}% to ${Math.round(startPct)}%` +
        `${litres !== null ? ` (about ${Math.round(litres)} L of the ${Math.round(machine.fuelTankLitres!)} L tank)` : ""}` +
        ` while the engine was off: stopped ${clockTime(stoppedAt, tz, now.getTime())}, started again ${clockTime(session.startedAt, tz, now.getTime())}` +
        ` (${formatHours(parked)} later). Check the tank and fuel cap.`,
    })
    .onConflictDoNothing()
    .returning();
}
