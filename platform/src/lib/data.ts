import "server-only";
import { and, desc, eq, gte, isNotNull, isNull, or } from "drizzle-orm";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { deviceEvents, devices, engineSessions, telemetry, type Device } from "@/lib/db/schema";
import { appTimeZone, ENGINE_THRESHOLDS, hoursByDay, startOfLocalDay } from "@/lib/telemetry/engine";
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

export type EngineStatus = "running" | "off" | "stale" | "unknown";

/**
 * What to show for the engine. "stale" = last known running, but the device has gone quiet,
 * so we can't confirm it's still running. (Off-and-quiet stays "off": the stock firmware
 * stops reporting when a machine is parked, which is expected.)
 */
export function engineStatus(device: Pick<Device, "engineOn" | "lastSeenAt">, now: number): EngineStatus {
  if (device.engineOn === null) return "unknown";
  if (!device.engineOn) return "off";
  const quietMin = (now - device.lastSeenAt.getTime()) / 60_000;
  return quietMin > ENGINE_THRESHOLDS.staleMinutes ? "stale" : "running";
}

/** Sessions that overlap the window starting at `since` (open ones always included). */
function sessionsSince(since: Date, deviceId?: string) {
  const overlap = or(isNull(engineSessions.endedAt), gte(engineSessions.endedAt, since));
  return getDb()
    .select()
    .from(engineSessions)
    .where(deviceId ? and(eq(engineSessions.deviceId, deviceId), overlap) : overlap);
}

/** Engine hours so far today (local time), keyed by device ID. */
export async function engineHoursToday(): Promise<Map<string, number>> {
  await requireSession();
  const now = Date.now();
  const tz = appTimeZone();
  const sessions = await sessionsSince(new Date(startOfLocalDay(now, tz)));
  const byDevice = Map.groupBy(sessions, (s) => s.deviceId);
  return new Map([...byDevice].map(([id, list]) => [id, hoursByDay(list, now, 1, tz)[0].hours]));
}

/** Engine hours for each of the last `days` days for one machine. */
export async function engineHoursByDay(id: string, days = 7) {
  await requireSession();
  const now = Date.now();
  const tz = appTimeZone();
  const sessions = await sessionsSince(new Date(startOfLocalDay(now, tz, days - 1)), id);
  return hoursByDay(sessions, now, days, tz);
}

export async function recentEngineSessions(id: string, limit = 10) {
  await requireSession();
  return getDb()
    .select()
    .from(engineSessions)
    .where(eq(engineSessions.deviceId, id))
    .orderBy(desc(engineSessions.startedAt))
    .limit(limit);
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
