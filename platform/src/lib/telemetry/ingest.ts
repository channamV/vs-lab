import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { deviceEvents, devices, engineSessions, telemetry, type EngineSession } from "@/lib/db/schema";
import { num, type SampleFields } from "@/lib/freematics/protocol";
import { detectEngine, ENGINE_THRESHOLDS, type EngineReading } from "./engine";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function isValidDeviceId(id: string): boolean {
  return DEVICE_ID_PATTERN.test(id);
}

/**
 * When false, data from devices that are not already in the database is rejected.
 * Default true so a new device shows up as soon as it reports. Set DEVICE_AUTO_REGISTER=false
 * once your devices are registered.
 */
export function autoRegisterEnabled(): boolean {
  return process.env.DEVICE_AUTO_REGISTER !== "false";
}

export class UnknownDeviceError extends Error {}

async function ensureDevice(db: Db, deviceId: string, autoRegister: boolean) {
  if (autoRegister) {
    await db.insert(devices).values({ id: deviceId }).onConflictDoNothing();
    return;
  }
  const existing = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId));
  if (existing.length === 0) throw new UnknownDeviceError(deviceId);
}

function validFix(lat: number | null, lng: number | null): lat is number {
  return (
    lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)
  );
}

export async function ingestSamples(
  db: Db,
  deviceId: string,
  samples: SampleFields[],
  opts: { autoRegister?: boolean; now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  await ensureDevice(db, deviceId, opts.autoRegister ?? autoRegisterEnabled());
  if (samples.length === 0) {
    await db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, deviceId));
    return 0;
  }

  const readings = samples.map(detectEngine);
  const rows = samples.map((f, i) => {
    const lat = num(f, "lat");
    const lng = num(f, "lng");
    const hasFix = validFix(lat, lng);
    const centivolts = num(f, "batteryCentivolts");
    return {
      deviceId,
      receivedAt: now,
      deviceMs: num(f, "deviceMs"),
      lat: hasFix ? lat : null,
      lng: hasFix ? lng : null,
      altitudeM: num(f, "altitudeM"),
      speedKph: num(f, "speedKph"),
      heading: num(f, "heading"),
      satellites: num(f, "satellites"),
      batteryV: centivolts === null ? null : centivolts / 100,
      rssi: num(f, "rssi"),
      deviceTempC: num(f, "deviceTempC"),
      engineOn: readings[i].running,
      fields: f,
    };
  });
  await db.insert(telemetry).values(rows);

  // Update the device's "latest" snapshot. Each value keeps its previous value
  // if this batch didn't include it (e.g. no GPS fix indoors).
  const latest = <K extends keyof (typeof rows)[number]>(key: K) =>
    rows.findLast((r) => r[key] !== null)?.[key] ?? null;
  const lastFix = rows.findLast((r) => r.lat !== null);

  await db
    .update(devices)
    .set({
      lastSeenAt: now,
      ...(lastFix && { lastFixAt: now, lastLat: lastFix.lat, lastLng: lastFix.lng }),
      lastSpeedKph: sql`coalesce(${latest("speedKph")}, ${devices.lastSpeedKph})`,
      lastBatteryV: sql`coalesce(${latest("batteryV")}, ${devices.lastBatteryV})`,
      lastRssi: sql`coalesce(${latest("rssi")}, ${devices.lastRssi})`,
    })
    .where(eq(devices.id, deviceId));

  // Samples in one upload arrive together, so the last one with a reading decides the engine state.
  const lastReading = readings.findLast((r) => r.running !== null);
  if (lastReading) await updateEngineState(db, deviceId, lastReading, now);

  return rows.length;
}

/**
 * Keeps the engine session table in step with the latest reading:
 *  - running, no open session      → open one
 *  - running, open session         → extend it
 *  - stopped, open session         → close it
 *  - open session gone stale (device silent > staleMinutes) → close it at its last report first
 */
async function updateEngineState(db: Db, deviceId: string, reading: EngineReading, now: Date) {
  const openWhere = and(eq(engineSessions.deviceId, deviceId), isNull(engineSessions.endedAt));
  let open: EngineSession | undefined = (await db.select().from(engineSessions).where(openWhere))[0];

  const staleMs = ENGINE_THRESHOLDS.staleMinutes * 60_000;
  if (open && now.getTime() - open.lastSeenAt.getTime() > staleMs) {
    await db.update(engineSessions).set({ endedAt: open.lastSeenAt }).where(eq(engineSessions.id, open.id));
    open = undefined;
  }

  if (reading.running) {
    if (open) {
      await db.update(engineSessions).set({ lastSeenAt: now }).where(eq(engineSessions.id, open.id));
    } else {
      // The unique index allows only one open session; a simultaneous upload may have opened it already.
      await db
        .insert(engineSessions)
        .values({ deviceId, startedAt: now, lastSeenAt: now, source: reading.source })
        .onConflictDoNothing();
    }
  } else if (open) {
    await db.update(engineSessions).set({ endedAt: now, lastSeenAt: now }).where(eq(engineSessions.id, open.id));
  }

  // engineChangedAt marks when the current state began ("running since 9:42").
  // It moves when the state flips, or when a new running session starts after a stale one.
  const [prev] = await db.select({ engineOn: devices.engineOn }).from(devices).where(eq(devices.id, deviceId));
  const startedNewSession = reading.running && !open;
  if (prev?.engineOn !== reading.running || startedNewSession) {
    await db.update(devices).set({ engineOn: reading.running, engineChangedAt: now }).where(eq(devices.id, deviceId));
  }
}

export async function recordEvent(
  db: Db,
  deviceId: string,
  event: { type: string; rssi?: number | null; vin?: string | null },
  opts: { autoRegister?: boolean; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  await ensureDevice(db, deviceId, opts.autoRegister ?? autoRegisterEnabled());
  await db.insert(deviceEvents).values({
    deviceId,
    at: now,
    type: event.type,
    rssi: event.rssi ?? null,
    detail: event.vin ? `VIN ${event.vin}` : null,
  });
  await db
    .update(devices)
    .set({
      lastSeenAt: now,
      ...(event.rssi != null && { lastRssi: event.rssi }),
      ...(event.vin && { vin: event.vin }),
    })
    .where(eq(devices.id, deviceId));
}
