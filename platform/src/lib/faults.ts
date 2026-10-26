import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { machineFaults, machines } from "@/lib/db/schema";
import { num, type SampleFields } from "@/lib/freematics/protocol";
import { decodeFault, describeFault, lampsText } from "@/lib/j1939";
import { recordEvent } from "@/lib/notifications";

/**
 * Engine data from the machine's J1939 engine computer (sent by our firmware fork; see docs/can-data.md):
 * the engine hour meter, and active fault codes. A fault opens a row (and an "Engine Fault Code" event)
 * when it first appears, stays open while it keeps being reported, and is closed when the engine computer
 * stops reporting it. Returns the number of events recorded.
 */
export async function updateEngineData(db: Db, machineId: number, samples: SampleFields[], now = new Date()): Promise<number> {
  const hours = samples.map((s) => num(s, "j1939EngineHours")).findLast((h) => h !== null && h > 0);
  if (hours !== undefined && hours !== null) {
    await db.update(machines).set({ engineHourMeter: hours, engineHourMeterAt: now }).where(eq(machines.id, machineId));
  }
  // The vehicle's odometer (J1939, or OBD PID A6 on newer vehicles): maintenance by km and checklists' readings.
  const km = samples.map((s) => num(s, "j1939OdometerKm") ?? num(s, "obdOdometerKm")).findLast((v) => v !== null && v > 0);
  if (km !== undefined && km !== null) {
    await db.update(machines).set({ odometerKm: km, odometerKmAt: now }).where(eq(machines.id, machineId));
  }
  const report = samples.findLast((s) => s.j1939Faults !== undefined);
  if (!report) return 0;
  const raw = report.j1939Faults;
  const codes = (Array.isArray(raw) ? raw : [raw]).filter((c) => Number.isInteger(c) && c > 0);
  const active = [...new Map(codes.map((c) => [c, decodeFault(c)])).values()];
  const lamps = num(report, "j1939Lamps");

  const [m] = await db.select({ organizationId: machines.organizationId }).from(machines).where(eq(machines.id, machineId));
  if (!m) return 0;
  const open = await db
    .select()
    .from(machineFaults)
    .where(and(eq(machineFaults.machineId, machineId), isNull(machineFaults.clearedAt)));
  const key = (f: { spn: number; fmi: number }) => `${f.spn}/${f.fmi}`;
  const activeKeys = new Set(active.map(key));
  for (const f of open) {
    if (!activeKeys.has(key(f))) await db.update(machineFaults).set({ clearedAt: now }).where(eq(machineFaults.id, f.id));
  }
  let events = 0;
  for (const f of active) {
    const existing = open.find((o) => key(o) === key(f));
    if (existing) {
      await db.update(machineFaults).set({ lastSeenAt: now, lamps }).where(eq(machineFaults.id, existing.id));
      continue;
    }
    const [created] = await db
      .insert(machineFaults)
      .values({ organizationId: m.organizationId, machineId, spn: f.spn, fmi: f.fmi, lamps, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoNothing()
      .returning();
    if (!created) continue;
    const lampNote = lampsText(lamps);
    const id = await recordEvent(db, {
      organizationId: m.organizationId,
      machineId,
      type: "engine_fault",
      detail: `${describeFault(f)}.${lampNote ? ` Lamps on: ${lampNote}.` : ""}`,
      occurredAt: now,
    });
    if (id) events++;
  }
  return events;
}
