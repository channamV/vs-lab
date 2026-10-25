import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { machines } from "@/lib/db/schema";
import { recordEvent } from "@/lib/notifications";
import { ENGINE_THRESHOLDS } from "@/lib/telemetry/engine";

/**
 * Low battery warning. With the engine off, a healthy lead-acid battery rests at about 12.6 V (25.2 V on
 * 24 V machines); below about 11.9 V (23.8 V) it's roughly 20–30% charged and the machine may not start.
 * Running readings are ignored (the alternator lifts them). A low reading has to be confirmed by another
 * one a few minutes later, so the brief dip while cranking the engine doesn't count. One warning per low
 * spell; it clears once an engine-off reading is comfortably healthy again. See docs/alerts.md.
 */
export const BATTERY_RULES = {
  low12V: 11.9,
  low24V: 23.8,
  /** A warning clears once an engine-off reading is at least this much above the threshold. */
  recoverMarginV: 0.4,
  /** A low reading must still be low this many minutes later. */
  confirmMinutes: 3,
};

/** Which system the reading comes from, and the warning threshold for it. */
export function batteryThreshold(volts: number): { system: 12 | 24; threshold: number } {
  return volts > ENGINE_THRESHOLDS.volts24SystemAbove
    ? { system: 24, threshold: BATTERY_RULES.low24V }
    : { system: 12, threshold: BATTERY_RULES.low12V };
}

/**
 * Updates a machine's low battery state from a device report. `readings` are the report's battery
 * voltages with the engine state of each sample. Returns true if a warning event was recorded.
 */
export async function checkBattery(
  db: Db,
  machineId: number,
  readings: { volts: number | null; engineOn: boolean | null }[],
  now = new Date(),
): Promise<boolean> {
  // Below the floor the device is on USB or a bench supply, not the machine's battery.
  const resting = readings.filter(
    (r) => r.engineOn === false && r.volts !== null && r.volts >= ENGINE_THRESHOLDS.machinePowerMinVolts,
  );
  const last = resting.at(-1);
  if (!last) return false;
  const volts = last.volts!;
  const [m] = await db
    .select({
      organizationId: machines.organizationId,
      pendingAt: machines.batteryLowPendingAt,
      lowAt: machines.batteryLowAt,
    })
    .from(machines)
    .where(eq(machines.id, machineId));
  if (!m) return false;
  const { system, threshold } = batteryThreshold(volts);

  if (volts >= threshold) {
    const recovered = m.lowAt && volts >= threshold + BATTERY_RULES.recoverMarginV;
    if (m.pendingAt || recovered) {
      await db
        .update(machines)
        .set({ batteryLowPendingAt: null, ...(recovered ? { batteryLowAt: null, batteryLowVolts: null } : {}) })
        .where(eq(machines.id, machineId));
    }
    return false;
  }
  if (m.lowAt) {
    await db.update(machines).set({ batteryLowVolts: volts }).where(eq(machines.id, machineId));
    return false;
  }
  if (!m.pendingAt) {
    await db.update(machines).set({ batteryLowPendingAt: now }).where(eq(machines.id, machineId));
    return false;
  }
  if (now.getTime() - m.pendingAt.getTime() < BATTERY_RULES.confirmMinutes * 60_000) return false;

  await db
    .update(machines)
    .set({ batteryLowPendingAt: null, batteryLowAt: now, batteryLowVolts: volts })
    .where(eq(machines.id, machineId));
  await recordEvent(db, {
    organizationId: m.organizationId,
    machineId,
    type: "low_battery",
    detail: `Battery at ${volts.toFixed(1)} V with the engine off (${system} V system; the warning level is ${threshold} V). The machine may not start: check or charge the battery.`,
    occurredAt: now,
  });
  return true;
}
