import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { engineSessions, telemetry, type EngineSession } from "@/lib/db/schema";
import { distanceM, dropOutliers } from "@/lib/history-track";
import { effectiveEnd } from "@/lib/telemetry/engine";

/**
 * Distance travelled per engine-on period (Craig 2026-10-29; docs/reports.md). The vehicle's own odometer is the
 * accurate source (OBD PID A6 on newer vehicles, J1939 on trucks); it's read about once a minute, so GPS covers the
 * minutes before its first and after its last reading. Without an odometer, GPS alone: positions are counted only
 * once the machine has moved a little (`gpsStepM`), so GPS jitter while parked or idling doesn't add up.
 */
export const DISTANCE_RULES = {
  /** GPS: count movement only once the machine is this far from the last counted spot. */
  gpsStepM: 25,
  /** An odometer that goes backwards by more than this (or jumps faster than this speed) isn't trusted. */
  odometerSlackKm: 0.5,
  maxKph: 250,
  /** Work out a period's distance this long after it ended (late readings have arrived). */
  settleMinutes: 5,
  /** Periods worked out per run (the watchdog, every 5 minutes; older periods are filled in over time). */
  perRun: 50,
};

export type DistanceSource = "odometer" | "gps";
export type DistancePoint = { t: number; lat: number | null; lng: number | null; odometerKm: number | null };

const hasFix = (p: DistancePoint): p is DistancePoint & { lat: number; lng: number } =>
  p.lat !== null && p.lng !== null && !(p.lat === 0 && p.lng === 0);

/** GPS distance (km) between two times, counting only real movement (pure). */
export function gpsKm(points: DistancePoint[], from = -Infinity, to = Infinity): number {
  const fixes = dropOutliers(
    points.filter((p) => hasFix(p) && p.t >= from && p.t <= to).map((p) => ({ t: p.t, lat: p.lat!, lng: p.lng!, kph: null, heading: null, engineOn: null })),
  );
  let anchor = fixes[0];
  let m = 0;
  for (const p of fixes.slice(1)) {
    const d = distanceM(anchor, p);
    if (d >= DISTANCE_RULES.gpsStepM) {
      m += d;
      anchor = p;
    }
  }
  return m / 1000;
}

/** The odometer readings, if they can be trusted (always forwards, no impossible jumps); else null (pure). */
function odometerReadings(points: DistancePoint[]) {
  const odo = points.filter((p) => p.odometerKm !== null && p.odometerKm > 0).sort((a, b) => a.t - b.t);
  if (odo.length < 2) return null;
  for (let i = 1; i < odo.length; i++) {
    const km = odo[i].odometerKm! - odo[i - 1].odometerKm!;
    const hours = (odo[i].t - odo[i - 1].t) / 3_600_000;
    if (km < -DISTANCE_RULES.odometerSlackKm || km > DISTANCE_RULES.maxKph * hours + DISTANCE_RULES.odometerSlackKm) return null;
  }
  return odo;
}

/** Distance over one engine-on period's readings: odometer (plus GPS before/after its readings), else GPS (pure). */
export function distanceFrom(points: DistancePoint[]): { km: number; source: DistanceSource } | null {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const odo = odometerReadings(sorted);
  if (odo) {
    const first = odo[0];
    const last = odo.at(-1)!;
    const km = Math.max(0, last.odometerKm! - first.odometerKm!) + gpsKm(sorted, -Infinity, first.t) + gpsKm(sorted, last.t, Infinity);
    return { km, source: "odometer" };
  }
  if (sorted.filter(hasFix).length < 2) return null;
  return { km: gpsKm(sorted), source: "gps" };
}

const ODOMETER = sql<number | null>`coalesce((${telemetry.fields}->>'obdOdometerKm')::float, (${telemetry.fields}->>'j1939OdometerKm')::float)`;

/** Works out one engine-on period's distance from its readings. */
export async function sessionDistance(db: Db, s: EngineSession, now = Date.now()) {
  const rows = await db
    .select({ at: telemetry.recordedAt, lat: telemetry.lat, lng: telemetry.lng, odometerKm: ODOMETER })
    .from(telemetry)
    .where(and(eq(telemetry.machineId, s.machineId), gte(telemetry.recordedAt, s.startedAt), lte(telemetry.recordedAt, new Date(effectiveEnd(s, now)))))
    .orderBy(asc(telemetry.recordedAt));
  return distanceFrom(rows.map((r) => ({ t: r.at.getTime(), lat: r.lat, lng: r.lng, odometerKm: r.odometerKm === null ? null : Number(r.odometerKm) })));
}

/** Stores the distance of ended periods not worked out yet, newest first (watchdog). Returns how many. */
export async function fillSessionDistances(db: Db, now = new Date()) {
  const due = await db
    .select()
    .from(engineSessions)
    .where(and(isNull(engineSessions.distanceSource), isNotNull(engineSessions.endedAt), lt(engineSessions.endedAt, new Date(now.getTime() - DISTANCE_RULES.settleMinutes * 60_000))))
    .orderBy(desc(engineSessions.endedAt))
    .limit(DISTANCE_RULES.perRun);
  for (const s of due) {
    const d = await sessionDistance(db, s, now.getTime());
    await db
      .update(engineSessions)
      .set({ distanceKm: d ? Math.round(d.km * 100) / 100 : null, distanceSource: d?.source ?? "none" })
      .where(eq(engineSessions.id, s.id));
  }
  return due.length;
}
