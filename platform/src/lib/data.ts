import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import {
  alerts,
  checkins,
  deviceEvents,
  devices,
  engineSessions,
  machineOperators,
  operators,
  telemetry,
  type Device,
} from "@/lib/db/schema";
import { automaticEnd, checkinEngine, engineStoppedAt, type CheckinEngine } from "@/lib/operators";
import { appTimeZone, ENGINE_THRESHOLDS, hoursByDay, startOfLocalDay } from "@/lib/telemetry/engine";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";

/**
 * All page data goes through these functions. Each one checks the session itself
 * (in addition to proxy.ts) so data can't leak if a route is ever left unprotected.
 */
/** True if the request carries a valid sign-in (for UI that also renders on the sign-in page). */
async function signedIn() {
  const store = await cookies();
  return isValidSession(store.get(SESSION_COOKIE)?.value);
}

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

// ---------- Operators and check-ins ----------

export async function listOperators() {
  await requireSession();
  const db = getDb();
  const [ops, assignments] = await Promise.all([
    db.select().from(operators).orderBy(desc(operators.active), asc(operators.name)),
    db
      .select({ operatorId: machineOperators.operatorId, deviceId: devices.id, name: devices.name })
      .from(machineOperators)
      .innerJoin(devices, eq(devices.id, machineOperators.deviceId)),
  ]);
  const machinesFor = Map.groupBy(assignments, (a) => a.operatorId);
  return ops.map((op) => ({ ...op, machines: machinesFor.get(op.id) ?? [] }));
}

export async function getOperator(id: number) {
  await requireSession();
  const [op] = await getDb().select().from(operators).where(eq(operators.id, id));
  return op ?? null;
}

/** IDs of the operators allowed on a machine (empty = any active operator). */
export async function allowedOperatorIds(deviceId: string) {
  await requireSession();
  const rows = await getDb()
    .select({ id: machineOperators.operatorId })
    .from(machineOperators)
    .where(eq(machineOperators.deviceId, deviceId));
  return rows.map((r) => r.id);
}

const checkinWithOperator = {
  id: checkins.id,
  deviceId: checkins.deviceId,
  operatorId: checkins.operatorId,
  operatorName: operators.name,
  startedAt: checkins.startedAt,
  endedAt: checkins.endedAt,
  endReason: checkins.endReason,
  authorized: checkins.authorized,
  checklistOk: checkins.checklistOk,
  answers: checkins.answers,
  notes: checkins.notes,
  locationCheck: checkins.locationCheck,
  distanceM: checkins.distanceM,
  engineSessionId: checkins.engineSessionId,
  engineLink: checkins.engineLink,
  method: checkins.method,
};

type CheckinRow = {
  startedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  engineSessionId: number | null;
  engineLink: string | null;
  method: string;
};

/**
 * Adds what happened with the engine to each check-in, and applies automatic check-out (engine
 * stopped / never started) even if no device report has saved it yet, so pages are always current.
 */
async function withEngine<T extends CheckinRow>(
  rows: T[],
): Promise<(T & { engine: CheckinEngine; current: boolean; engineOffSince: Date | null })[]> {
  if (rows.length === 0) return [];
  const now = Date.now();
  const ids = [...new Set(rows.map((r) => r.engineSessionId).filter((id) => id !== null))];
  const sessions = ids.length ? await getDb().select().from(engineSessions).where(inArray(engineSessions.id, ids)) : [];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return rows.map((r) => {
    const linked = r.engineSessionId ? (byId.get(r.engineSessionId) ?? null) : null;
    const end = r.endedAt ? null : automaticEnd(r, linked, now);
    const row = end ? { ...r, ...end } : r;
    // Still checked in with the engine off = on a break (web check-ins survive a short stop).
    const engineOffSince = !row.endedAt && linked ? engineStoppedAt(linked, now) : null;
    return { ...row, engine: checkinEngine(row, linked, now), current: !row.endedAt, engineOffSince };
  });
}

/** The operator currently checked in on each machine, keyed by device ID. */
export async function currentCheckins() {
  await requireSession();
  const rows = await getDb()
    .select(checkinWithOperator)
    .from(checkins)
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .where(isNull(checkins.endedAt));
  return new Map((await withEngine(rows)).filter((r) => r.current).map((r) => [r.deviceId, r]));
}

export async function recentCheckins(deviceId: string, limit = 10) {
  await requireSession();
  const rows = await getDb()
    .select(checkinWithOperator)
    .from(checkins)
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .where(eq(checkins.deviceId, deviceId))
    .orderBy(desc(checkins.startedAt))
    .limit(limit);
  return withEngine(rows);
}

// ---------- Alerts ----------

const alertWithMachine = {
  id: alerts.id,
  deviceId: alerts.deviceId,
  machineName: devices.name,
  type: alerts.type,
  createdAt: alerts.createdAt,
  title: alerts.title,
  detail: alerts.detail,
  acknowledgedAt: alerts.acknowledgedAt,
  ackNote: alerts.ackNote,
  emailStatus: alerts.emailStatus,
  emailError: alerts.emailError,
};

/** Open (unacknowledged) alerts, newest first. */
export async function openAlerts(deviceId?: string) {
  await requireSession();
  return getDb()
    .select(alertWithMachine)
    .from(alerts)
    .innerJoin(devices, eq(devices.id, alerts.deviceId))
    .where(and(isNull(alerts.acknowledgedAt), deviceId ? eq(alerts.deviceId, deviceId) : undefined))
    .orderBy(desc(alerts.createdAt));
}

export async function acknowledgedAlerts(limit = 30, deviceId?: string) {
  await requireSession();
  return getDb()
    .select(alertWithMachine)
    .from(alerts)
    .innerJoin(devices, eq(devices.id, alerts.deviceId))
    .where(and(isNotNull(alerts.acknowledgedAt), deviceId ? eq(alerts.deviceId, deviceId) : undefined))
    .orderBy(desc(alerts.createdAt))
    .limit(limit);
}

/** Number of open alerts for the nav bar, or null when not signed in (the sign-in page shares the layout). */
export async function openAlertCountIfSignedIn(): Promise<number | null> {
  await connection();
  if (!(await signedIn())) return null;
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(alerts)
    .where(isNull(alerts.acknowledgedAt));
  return row.count;
}
