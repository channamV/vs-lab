import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { checkins, engineSessions, operators, telemetry } from "@/lib/db/schema";
import { batteryThreshold } from "@/lib/battery";
import { ENGINE_THRESHOLDS } from "@/lib/telemetry/engine";
import {
  dropOutliers,
  findStops,
  splitSegments,
  trackDistanceKm,
  type TrackPoint,
  type VoltagePoint,
} from "@/lib/history-track";

/**
 * Machine history for the battery chart and the location history / replay page (docs/location-history.md).
 * Telemetry arrives every 1–5 s while a machine runs, so long ranges are summarised in the database: per time
 * slice, the voltage's lowest/highest/average (a short dip is never averaged away) and one position.
 */

export const HISTORY_RULES = {
  /** Time slices on the voltage chart. */
  voltageBuckets: 300,
  /** Positions sent to the map; longer ranges keep one per time slice. */
  maxTrackPoints: 5000,
};

const range = (machineId: number, from: number, to: number) =>
  and(eq(telemetry.machineId, machineId), gte(telemetry.recordedAt, new Date(from)), lt(telemetry.recordedAt, new Date(to)));

/** Engine-on periods overlapping the range, clipped to it. */
async function engineSpans(db: Db, machineId: number, from: number, to: number, now: number) {
  const rows = await db
    .select({ start: engineSessions.startedAt, end: engineSessions.endedAt, lastSeen: engineSessions.lastSeenAt })
    .from(engineSessions)
    .where(
      and(
        eq(engineSessions.machineId, machineId),
        lt(engineSessions.startedAt, new Date(to)),
        or(isNull(engineSessions.endedAt), gt(engineSessions.endedAt, new Date(from))),
      ),
    )
    .orderBy(asc(engineSessions.startedAt));
  return rows.map((r) => ({
    from: Math.max(from, r.start.getTime()),
    to: Math.min(to, (r.end ?? (now - r.lastSeen.getTime() < 10 * 60_000 ? new Date(now) : r.lastSeen)).getTime()),
  }));
}

/**
 * Battery voltage over a range: per time slice min/max/average, engine-on periods, and a summary. Readings under the
 * machine-power floor (device on USB or a bench supply) are left out, as in the low battery warning.
 */
export async function voltageHistory(db: Db, machineId: number, from: number, to: number, now = Date.now()) {
  const bucketSeconds = Math.max(60, Math.ceil((to - from) / 1000 / HISTORY_RULES.voltageBuckets));
  // Inlined (a whole number we computed): GROUP BY must see the same expression as SELECT, not new parameters.
  const bucket = sql<number>`floor(extract(epoch from ${telemetry.recordedAt}) / ${sql.raw(String(Math.trunc(bucketSeconds)))})`;
  const rows = await db
    .select({
      b: bucket,
      min: sql<number>`min(${telemetry.batteryV})`,
      max: sql<number>`max(${telemetry.batteryV})`,
      avg: sql<number>`avg(${telemetry.batteryV})`,
      n: sql<number>`count(*)`,
      engineOn: sql<boolean>`coalesce(bool_or(${telemetry.engineOn}), false)`,
    })
    .from(telemetry)
    .where(and(range(machineId, from, to), isNotNull(telemetry.batteryV), gte(telemetry.batteryV, ENGINE_THRESHOLDS.machinePowerMinVolts)))
    .groupBy(bucket)
    .orderBy(bucket);
  const points: VoltagePoint[] = rows.map((r) => ({
    t: Number(r.b) * bucketSeconds * 1000,
    min: Number(r.min),
    max: Number(r.max),
    avg: Number(r.avg),
    n: Number(r.n),
    engineOn: Boolean(r.engineOn),
  }));
  const [latest] = await db
    .select({ v: telemetry.batteryV, at: telemetry.recordedAt })
    .from(telemetry)
    .where(and(range(machineId, from, to), isNotNull(telemetry.batteryV), gte(telemetry.batteryV, ENGINE_THRESHOLDS.machinePowerMinVolts)))
    .orderBy(desc(telemetry.recordedAt))
    .limit(1);
  const readings = points.reduce((s, p) => s + p.n, 0);
  // 12 V or 24 V system: judged from the typical reading, like the low battery warning.
  const typical = points.length ? [...points.map((p) => p.avg)].sort((a, b) => a - b)[Math.floor(points.length / 2)] : null;
  const system = typical === null ? null : batteryThreshold(typical);
  return {
    bucketSeconds,
    points,
    engine: await engineSpans(db, machineId, from, to, now),
    summary: {
      latest: latest ? { v: latest.v!, at: latest.at.getTime() } : null,
      min: points.length ? Math.min(...points.map((p) => p.min)) : null,
      max: points.length ? Math.max(...points.map((p) => p.max)) : null,
      avg: readings ? points.reduce((s, p) => s + p.avg * p.n, 0) / readings : null,
      readings,
      system: system?.system ?? null,
      lowThreshold: system?.threshold ?? null,
    },
  };
}

export type VoltageHistory = Awaited<ReturnType<typeof voltageHistory>>;

/** Positions over a range (thinned to one per time slice when there are many), with stops, segments and operators. */
export async function locationHistory(db: Db, machineId: number, from: number, to: number, now = Date.now()) {
  const where = and(range(machineId, from, to), isNotNull(telemetry.lat), isNotNull(telemetry.lng), sql`not (${telemetry.lat} = 0 and ${telemetry.lng} = 0)`);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(telemetry).where(where);
  const total = Number(count);
  const columns = {
    at: telemetry.recordedAt,
    lat: telemetry.lat,
    lng: telemetry.lng,
    kph: telemetry.speedKph,
    heading: telemetry.heading,
    engineOn: telemetry.engineOn,
  };
  let rows: { at: Date; lat: number | null; lng: number | null; kph: number | null; heading: number | null; engineOn: boolean | null }[];
  let thinnedToSeconds: number | null = null;
  if (total <= HISTORY_RULES.maxTrackPoints) {
    rows = await db.select(columns).from(telemetry).where(where).orderBy(asc(telemetry.recordedAt));
  } else {
    // One position per time slice: the first one in it.
    thinnedToSeconds = Math.ceil((to - from) / 1000 / HISTORY_RULES.maxTrackPoints);
    const slice = sql`floor(extract(epoch from ${telemetry.recordedAt}) / ${sql.raw(String(Math.trunc(thinnedToSeconds)))})`;
    rows = await db
      .selectDistinctOn([slice], columns)
      .from(telemetry)
      .where(where)
      .orderBy(slice, asc(telemetry.recordedAt));
  }
  const points: TrackPoint[] = dropOutliers(
    rows.map((r) => ({ t: r.at.getTime(), lat: r.lat!, lng: r.lng!, kph: r.kph, heading: r.heading, engineOn: r.engineOn })),
  );
  const segments = splitSegments(points);
  const stops = findStops(points);

  // Who was checked in when (an open check-in counts until now).
  const shifts = await db
    .select({ start: checkins.startedAt, end: checkins.endedAt, name: operators.name })
    .from(checkins)
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .where(and(eq(checkins.machineId, machineId), lt(checkins.startedAt, new Date(to)), or(isNull(checkins.endedAt), gt(checkins.endedAt, new Date(from)))))
    .orderBy(asc(checkins.startedAt));

  const engine = await engineSpans(db, machineId, from, to, now);
  const engineMinutes = Math.round(engine.reduce((s, e) => s + Math.max(0, e.to - e.from), 0) / 60_000);
  return {
    points,
    segmentStarts: segments.slice(1).map((seg) => points.indexOf(seg[0])),
    stops,
    operators: shifts.map((s) => ({ name: s.name, from: s.start.getTime(), to: (s.end ?? new Date(now)).getTime() })),
    summary: {
      positions: total,
      thinnedToSeconds,
      distanceKm: trackDistanceKm(segments),
      maxKph: points.reduce((m, p) => Math.max(m, p.kph ?? 0), 0),
      engineMinutes,
      stops: stops.length,
    },
  };
}

export type LocationHistory = Awaited<ReturnType<typeof locationHistory>>;
