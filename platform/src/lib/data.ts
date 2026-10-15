import "server-only";
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { deviceEvents, devices, telemetry, type Device } from "@/lib/db/schema";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";

/**
 * All page data goes through these functions. Each one checks the session itself
 * (in addition to proxy.ts) so data can't leak if a route is ever left unprotected.
 */
async function requireSession() {
  await connection(); // always read fresh data at request time
  const store = await cookies();
  if (!(await isValidSession(store.get(SESSION_COOKIE)?.value))) throw new Error("Not signed in");
}

export type ConnectionStatus = "online" | "recent" | "offline";

export function connectionStatus(device: Pick<Device, "lastSeenAt">, now = Date.now()): ConnectionStatus {
  const ageMin = (now - device.lastSeenAt.getTime()) / 60_000;
  if (ageMin < 5) return "online";
  if (ageMin < 60) return "recent";
  return "offline";
}

/** The time this request is being served, for "x minutes ago" labels. */
export async function requestTime(): Promise<number> {
  await requireSession();
  return Date.now();
}

export async function listDevices() {
  await requireSession();
  return getDb().select().from(devices).orderBy(desc(devices.lastSeenAt));
}

export async function getDevice(id: string) {
  await requireSession();
  const [device] = await getDb().select().from(devices).where(eq(devices.id, id));
  return device ?? null;
}

export async function getTrack(id: string, hours = 24, limit = 2000) {
  await requireSession();
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await getDb()
    .select({ lat: telemetry.lat, lng: telemetry.lng, at: telemetry.receivedAt })
    .from(telemetry)
    .where(and(eq(telemetry.deviceId, id), gte(telemetry.receivedAt, since), isNotNull(telemetry.lat)))
    .orderBy(desc(telemetry.receivedAt))
    .limit(limit);
  return rows.reverse().map((r) => ({ lat: r.lat!, lng: r.lng!, at: r.at }));
}

export async function getRecentTelemetry(id: string, limit = 1) {
  await requireSession();
  return getDb()
    .select()
    .from(telemetry)
    .where(eq(telemetry.deviceId, id))
    .orderBy(desc(telemetry.receivedAt), desc(telemetry.id))
    .limit(limit);
}

export async function getRecentEvents(id: string, limit = 20) {
  await requireSession();
  return getDb()
    .select()
    .from(deviceEvents)
    .where(eq(deviceEvents.deviceId, id))
    .orderBy(desc(deviceEvents.at))
    .limit(limit);
}
