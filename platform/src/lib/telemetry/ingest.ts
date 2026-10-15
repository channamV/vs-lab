import { eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { deviceEvents, devices, telemetry } from "@/lib/db/schema";
import { num, type SampleFields } from "@/lib/freematics/protocol";

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

  const rows = samples.map((f) => {
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

  return rows.length;
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
