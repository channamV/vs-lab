import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { engineSessions, machines, meterReadings } from "@/lib/db/schema";
import { MAINTENANCE_RULES } from "@/lib/maintenance-types";
import { effectiveEnd } from "@/lib/telemetry/engine";

/**
 * Hour meter and odometer readings (docs/maintenance.md → Meter readings). Where a machine's current hours come from,
 * best first:
 *  1. the engine computer's own hour meter (J1939, `machines.engine_hour_meter`), when the device reads it;
 *  2. the latest reading someone gave (checklist, staff, service) plus the engine hours VS-lab measured since then.
 * Kilometres: the vehicle's odometer (OBD / J1939, `machines.odometer_km`), else the latest reading given.
 */

export type MeterKind = "hours" | "km";
export type Reading = {
  value: number;
  /** engine = from the engine computer; reading = as given; estimated = given + engine time measured since. */
  source: "engine" | "reading" | "estimated";
  at: Date;
};
export type MachineReadings = { hours: Reading | null; km: Reading | null };

/** Which reading a checklist asks for: kilometres on on-road vehicles, hours on everything else. */
export const meterKindFor = (m: { onRoad: boolean }): MeterKind => (m.onRoad ? "km" : "hours");

export class MeterError extends Error {}

/** A typed reading as a number, or an error message (pure). */
export function parseReading(raw: string | null | undefined): number | { error: string } | null {
  const text = (raw ?? "").replace(/[\s,]/g, "");
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > MAINTENANCE_RULES.maxReading) return { error: "Enter the reading as a number, e.g. 1234.5." };
  return Math.round(value * 10) / 10;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Current hours and kilometres for some machines. */
export async function currentReadings(db: Db, machineIds: number[], now = new Date()): Promise<Map<number, MachineReadings>> {
  const out = new Map<number, MachineReadings>();
  if (!machineIds.length) return out;
  const [ms, readings] = await Promise.all([
    db
      .select({ id: machines.id, engineHourMeter: machines.engineHourMeter, engineHourMeterAt: machines.engineHourMeterAt, odometerKm: machines.odometerKm, odometerKmAt: machines.odometerKmAt })
      .from(machines)
      .where(inArray(machines.id, machineIds)),
    // Latest of each kind per machine.
    db
      .selectDistinctOn([meterReadings.machineId, meterReadings.kind], {
        machineId: meterReadings.machineId,
        kind: meterReadings.kind,
        value: meterReadings.value,
        recordedAt: meterReadings.recordedAt,
      })
      .from(meterReadings)
      .where(inArray(meterReadings.machineId, machineIds))
      .orderBy(meterReadings.machineId, meterReadings.kind, desc(meterReadings.recordedAt), desc(meterReadings.id)),
  ]);
  const hoursBase = new Map(readings.filter((r) => r.kind === "hours").map((r) => [r.machineId, r]));
  const kmBase = new Map(readings.filter((r) => r.kind === "km").map((r) => [r.machineId, r]));
  // Engine time since each machine's latest hours reading (only for machines without the engine's own meter).
  const needEngine = ms.filter((m) => m.engineHourMeter === null && hoursBase.has(m.id));
  const since = needEngine.length ? new Date(Math.min(...needEngine.map((m) => hoursBase.get(m.id)!.recordedAt.getTime()))) : null;
  const sessions = since
    ? await db
        .select({ machineId: engineSessions.machineId, startedAt: engineSessions.startedAt, endedAt: engineSessions.endedAt, lastSeenAt: engineSessions.lastSeenAt })
        .from(engineSessions)
        .where(and(inArray(engineSessions.machineId, needEngine.map((m) => m.id)), or(isNull(engineSessions.endedAt), gt(engineSessions.endedAt, since))))
    : [];
  const t = now.getTime();
  for (const m of ms) {
    let hours: Reading | null = null;
    if (m.engineHourMeter !== null) hours = { value: round1(m.engineHourMeter), source: "engine", at: m.engineHourMeterAt ?? now };
    else {
      const base = hoursBase.get(m.id);
      if (base) {
        const from = base.recordedAt.getTime();
        let ms_ = 0;
        for (const s of sessions) {
          if (s.machineId !== m.id) continue;
          const start = Math.max(s.startedAt.getTime(), from);
          const end = Math.min(effectiveEnd(s, t), t);
          if (end > start) ms_ += end - start;
        }
        const added = ms_ / 3_600_000;
        hours = { value: round1(base.value + added), source: added >= 0.05 ? "estimated" : "reading", at: added >= 0.05 ? now : base.recordedAt };
      }
    }
    const kmRow = kmBase.get(m.id);
    // The vehicle's odometer unless someone gave a newer reading.
    const km: Reading | null =
      m.odometerKm !== null && (!kmRow || (m.odometerKmAt ?? now) >= kmRow.recordedAt)
        ? { value: Math.round(m.odometerKm), source: "engine", at: m.odometerKmAt ?? now }
        : kmRow
          ? { value: round1(kmRow.value), source: "reading", at: kmRow.recordedAt }
          : null;
    out.set(m.id, { hours, km });
  }
  return out;
}

export async function machineReadings(db: Db, machineId: number, now = new Date()): Promise<MachineReadings> {
  return (await currentReadings(db, [machineId], now)).get(machineId) ?? { hours: null, km: null };
}

/** Saves a reading given by an operator (checklist), staff, or at a service. */
export async function recordReading(
  db: Db,
  input: { organizationId: number; machineId: number; kind: MeterKind; value: number; source: "checklist" | "manual" | "service"; checkinId?: number | null; userId?: number | null },
  now = new Date(),
) {
  if (!Number.isFinite(input.value) || input.value < 0 || input.value > MAINTENANCE_RULES.maxReading) throw new MeterError("That reading isn't a sensible number.");
  const [machine] = await db
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.id, input.machineId), eq(machines.organizationId, input.organizationId)));
  if (!machine) throw new MeterError("Machine not found.");
  await db.insert(meterReadings).values({
    organizationId: input.organizationId,
    machineId: input.machineId,
    kind: input.kind,
    value: round1(input.value),
    source: input.source,
    checkinId: input.checkinId ?? null,
    userId: input.userId ?? null,
    recordedAt: now,
  });
}

/** Recent readings for a machine (machine page history). */
export async function readingHistory(db: Db, machineId: number, limit = 20) {
  return db
    .select()
    .from(meterReadings)
    .where(eq(meterReadings.machineId, machineId))
    .orderBy(desc(meterReadings.recordedAt), desc(meterReadings.id))
    .limit(limit);
}
