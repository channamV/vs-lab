import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { connection } from "next/server";
import { cache } from "react";
import { getDb } from "@/lib/db";
import {
  alerts,
  checkins,
  deviceEvents,
  devices,
  engineSessions,
  machineOperators,
  operators,
  organizations,
  telemetry,
  users,
  type Device,
} from "@/lib/db/schema";
import { automaticEnd, checkinEngine, engineStoppedAt, type CheckinEngine } from "@/lib/operators";
import { appTimeZone, ENGINE_THRESHOLDS, hoursByDay, startOfLocalDay } from "@/lib/telemetry/engine";
import type { AuthContext } from "@/lib/auth";
import { getAuth, requireAuth, requirePlatformAdmin, requireRoleForPage } from "@/lib/session";

/**
 * All page data goes through these functions. Each one checks the signed-in user itself (in addition
 * to proxy.ts) and only returns the user's organization's data, so nothing can leak between customers
 * even if a page forgets a check.
 */
async function requireSession(): Promise<AuthContext> {
  await connection(); // always read fresh data at request time
  return requireAuth();
}

/** The machine, if it belongs to the signed-in user's organization (looked up once per request). */
const deviceInOrg = cache(async (id: string, organizationId: number) => {
  const [device] = await getDb()
    .select()
    .from(devices)
    .where(and(eq(devices.id, id), eq(devices.organizationId, organizationId)));
  return device ?? null;
});

/** For per-machine data: the signed-in user, after checking the machine is in their organization. */
async function requireDevice(id: string): Promise<AuthContext> {
  const auth = await requireSession();
  if (!(await deviceInOrg(id, auth.organizationId))) throw new Error("Machine not found");
  return auth;
}

/** The signed-in user (for the nav bar), or null on the sign-in pages. */
export async function currentUser() {
  await connection();
  return getAuth();
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

/** Sessions that overlap the window starting at `since` (open ones always included), for one machine. */
function sessionsSince(since: Date, deviceId: string) {
  const overlap = or(isNull(engineSessions.endedAt), gte(engineSessions.endedAt, since));
  return getDb()
    .select()
    .from(engineSessions)
    .where(and(eq(engineSessions.deviceId, deviceId), overlap));
}

/** Engine hours so far today (local time), keyed by device ID, for the organization's machines. */
export async function engineHoursToday(): Promise<Map<string, number>> {
  const auth = await requireSession();
  const now = Date.now();
  const tz = appTimeZone();
  const since = new Date(startOfLocalDay(now, tz));
  const sessions = await getDb()
    .select({ session: engineSessions })
    .from(engineSessions)
    .innerJoin(devices, eq(devices.id, engineSessions.deviceId))
    .where(
      and(
        eq(devices.organizationId, auth.organizationId),
        or(isNull(engineSessions.endedAt), gte(engineSessions.endedAt, since)),
      ),
    )
    .then((rows) => rows.map((r) => r.session));
  const byDevice = Map.groupBy(sessions, (s) => s.deviceId);
  return new Map([...byDevice].map(([id, list]) => [id, hoursByDay(list, now, 1, tz)[0].hours]));
}

/** Engine hours for each of the last `days` days for one machine. */
export async function engineHoursByDay(id: string, days = 7) {
  await requireDevice(id);
  const now = Date.now();
  const tz = appTimeZone();
  const sessions = await sessionsSince(new Date(startOfLocalDay(now, tz, days - 1)), id);
  return hoursByDay(sessions, now, days, tz);
}

export async function recentEngineSessions(id: string, limit = 10) {
  await requireDevice(id);
  return getDb()
    .select()
    .from(engineSessions)
    .where(eq(engineSessions.deviceId, id))
    .orderBy(desc(engineSessions.startedAt))
    .limit(limit);
}

export async function listDevices() {
  const auth = await requireSession();
  return getDb()
    .select()
    .from(devices)
    .where(eq(devices.organizationId, auth.organizationId))
    .orderBy(desc(devices.lastSeenAt));
}

/** The machine, or null if it doesn't exist or belongs to another organization. */
export async function getDevice(id: string) {
  const auth = await requireSession();
  return deviceInOrg(id, auth.organizationId);
}

export async function getTrack(id: string, hours = 24, limit = 2000) {
  await requireDevice(id);
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
  await requireDevice(id);
  return getDb()
    .select()
    .from(telemetry)
    .where(eq(telemetry.deviceId, id))
    .orderBy(desc(telemetry.receivedAt), desc(telemetry.id))
    .limit(limit);
}

export async function getRecentEvents(id: string, limit = 20) {
  await requireDevice(id);
  return getDb()
    .select()
    .from(deviceEvents)
    .where(eq(deviceEvents.deviceId, id))
    .orderBy(desc(deviceEvents.at))
    .limit(limit);
}

// ---------- Operators and check-ins ----------

export async function listOperators() {
  const auth = await requireSession();
  const db = getDb();
  const [ops, assignments] = await Promise.all([
    db
      .select()
      .from(operators)
      .where(eq(operators.organizationId, auth.organizationId))
      .orderBy(desc(operators.active), asc(operators.name)),
    db
      .select({ operatorId: machineOperators.operatorId, deviceId: devices.id, name: devices.name })
      .from(machineOperators)
      .innerJoin(devices, eq(devices.id, machineOperators.deviceId))
      .where(eq(devices.organizationId, auth.organizationId)),
  ]);
  const machinesFor = Map.groupBy(assignments, (a) => a.operatorId);
  return ops.map((op) => ({ ...op, machines: machinesFor.get(op.id) ?? [] }));
}

export async function getOperator(id: number) {
  const auth = await requireSession();
  const [op] = await getDb()
    .select()
    .from(operators)
    .where(and(eq(operators.id, id), eq(operators.organizationId, auth.organizationId)));
  return op ?? null;
}

/** IDs of the operators allowed on a machine (empty = any active operator). */
export async function allowedOperatorIds(deviceId: string) {
  await requireDevice(deviceId);
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
  const auth = await requireSession();
  const rows = await getDb()
    .select(checkinWithOperator)
    .from(checkins)
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .where(and(eq(checkins.organizationId, auth.organizationId), isNull(checkins.endedAt)));
  return new Map((await withEngine(rows)).filter((r) => r.current).map((r) => [r.deviceId, r]));
}

export async function recentCheckins(deviceId: string, limit = 10) {
  const auth = await requireDevice(deviceId);
  const rows = await getDb()
    .select(checkinWithOperator)
    .from(checkins)
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .where(and(eq(checkins.deviceId, deviceId), eq(checkins.organizationId, auth.organizationId)))
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
  const auth = await requireSession();
  return getDb()
    .select(alertWithMachine)
    .from(alerts)
    .innerJoin(devices, eq(devices.id, alerts.deviceId))
    .where(
      and(
        eq(alerts.organizationId, auth.organizationId),
        isNull(alerts.acknowledgedAt),
        deviceId ? eq(alerts.deviceId, deviceId) : undefined,
      ),
    )
    .orderBy(desc(alerts.createdAt));
}

export async function acknowledgedAlerts(limit = 30, deviceId?: string) {
  const auth = await requireSession();
  return getDb()
    .select(alertWithMachine)
    .from(alerts)
    .innerJoin(devices, eq(devices.id, alerts.deviceId))
    .where(
      and(
        eq(alerts.organizationId, auth.organizationId),
        isNotNull(alerts.acknowledgedAt),
        deviceId ? eq(alerts.deviceId, deviceId) : undefined,
      ),
    )
    .orderBy(desc(alerts.createdAt))
    .limit(limit);
}

/** Number of open alerts for the nav bar, or null when not signed in (the sign-in page shares the layout). */
export async function openAlertCountIfSignedIn(): Promise<number | null> {
  await connection();
  const auth = await getAuth();
  if (!auth) return null;
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(alerts)
    .where(and(eq(alerts.organizationId, auth.organizationId), isNull(alerts.acknowledgedAt)));
  return row.count;
}

// ---------- Organization users (owners manage them) ----------

export async function listUsers() {
  await connection();
  const auth = await requireRoleForPage("owner");
  return getDb()
    .select()
    .from(users)
    .where(eq(users.organizationId, auth.organizationId))
    .orderBy(desc(users.active), asc(users.email));
}

// ---------- Platform admin (Veristart staff) ----------

export async function listOrganizations() {
  await connection();
  await requirePlatformAdmin();
  const db = getDb();
  const [orgs, counts, userCounts] = await Promise.all([
    db.select().from(organizations).orderBy(asc(organizations.name)),
    db
      .select({ organizationId: devices.organizationId, n: sql<number>`count(*)::int` })
      .from(devices)
      .groupBy(devices.organizationId),
    db
      .select({ organizationId: users.organizationId, n: sql<number>`count(*)::int` })
      .from(users)
      .groupBy(users.organizationId),
  ]);
  const machines = new Map(counts.map((c) => [c.organizationId, c.n]));
  const people = new Map(userCounts.map((c) => [c.organizationId, c.n]));
  return orgs.map((o) => ({ ...o, machines: machines.get(o.id) ?? 0, users: people.get(o.id) ?? 0 }));
}

/** Devices that have reported but aren't assigned to an organization yet. */
export async function unclaimedDevices() {
  await connection();
  await requirePlatformAdmin();
  return getDb().select().from(devices).where(isNull(devices.organizationId)).orderBy(desc(devices.lastSeenAt));
}

/** All machines with their organization, for moving a machine between organizations. */
export async function allDevicesWithOrganization() {
  await connection();
  await requirePlatformAdmin();
  return getDb()
    .select({ id: devices.id, name: devices.name, lastSeenAt: devices.lastSeenAt, organizationId: devices.organizationId })
    .from(devices)
    .orderBy(asc(devices.id));
}

/** Platform admins: organization names for the switcher in the nav bar. */
export async function listOrganizationsForSwitcher() {
  await connection();
  await requirePlatformAdmin();
  return getDb().select({ id: organizations.id, name: organizations.name }).from(organizations).orderBy(asc(organizations.name));
}
