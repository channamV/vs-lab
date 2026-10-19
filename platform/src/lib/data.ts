import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { connection } from "next/server";
import { cache } from "react";
import { getDb } from "@/lib/db";
import {
  alerts,
  checkins,
  deviceAssignments,
  deviceEvents,
  devices,
  divisions,
  engineSessions,
  machineOperators,
  machines,
  operators,
  organizations,
  telemetry,
  userDivisions,
  users,
} from "@/lib/db/schema";
import { machineScope, type Scope } from "@/lib/divisions";
import { listSubscriptions, scopeOfUser } from "@/lib/subscriptions";
import { hasRole } from "@/lib/auth";
import { automaticEnd, checkinEngine, engineStoppedAt, type CheckinEngine } from "@/lib/operators";
import { appTimeZone, ENGINE_THRESHOLDS, hoursByDay, startOfLocalDay } from "@/lib/telemetry/engine";
import type { AuthContext } from "@/lib/auth";
import { getAuth, requireAuth, requirePlatformAdmin, requireRoleForPage } from "@/lib/session";

/**
 * All page data goes through these functions. Each one checks the signed-in user itself (in addition
 * to proxy.ts) and only returns the user's organization's data, so nothing can leak between customers
 * even if a page forgets a check. Users limited to some divisions only see those divisions' machines
 * (machineScope), and the check-ins and alerts on them.
 */
async function requireSession(): Promise<AuthContext> {
  await connection(); // always read fresh data at request time
  return requireAuth();
}

/** The machine, if the signed-in user can see it (looked up once per request; cache keys must be simple values). */
const cachedMachine = cache(async (id: number, organizationId: number, divisionKey: string) => {
  const scope: Scope = { organizationId, divisionIds: divisionKey ? divisionKey.split(",").map(Number) : null };
  const [machine] = await getDb()
    .select()
    .from(machines)
    .where(and(eq(machines.id, id), machineScope(scope)));
  return machine ?? null;
});
const machineInScope = (id: number, scope: Scope) => cachedMachine(id, scope.organizationId, scope.divisionIds?.join(",") ?? "");

/** For per-machine data: the signed-in user, after checking they can see the machine. */
async function requireMachine(id: number): Promise<AuthContext> {
  const auth = await requireSession();
  if (!(await machineInScope(id, auth))) throw new Error("Machine not found");
  return auth;
}

/** Open pairings: which device is on which machine right now. */
const currentDevice = and(eq(deviceAssignments.machineId, machines.id), isNull(deviceAssignments.endedAt));

/** The signed-in user (for the nav bar), or null on the sign-in pages. */
export async function currentUser() {
  await connection();
  return getAuth();
}

export type ConnectionStatus = "online" | "recent" | "offline";

export function connectionStatus(item: { lastSeenAt: Date | null }, now = Date.now()): ConnectionStatus {
  if (!item.lastSeenAt) return "offline";
  const ageMin = (now - item.lastSeenAt.getTime()) / 60_000;
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
export function engineStatus(machine: { engineOn: boolean | null; lastSeenAt: Date | null }, now: number): EngineStatus {
  if (machine.engineOn === null || !machine.lastSeenAt) return "unknown";
  if (!machine.engineOn) return "off";
  const quietMin = (now - machine.lastSeenAt.getTime()) / 60_000;
  return quietMin > ENGINE_THRESHOLDS.staleMinutes ? "stale" : "running";
}

/** Sessions that overlap the window starting at `since` (open ones always included), for one machine. */
function sessionsSince(since: Date, machineId: number) {
  const overlap = or(isNull(engineSessions.endedAt), gte(engineSessions.endedAt, since));
  return getDb()
    .select()
    .from(engineSessions)
    .where(and(eq(engineSessions.machineId, machineId), overlap));
}

/** Engine hours so far today (local time), keyed by machine ID, for the organization's machines. */
export async function engineHoursToday(): Promise<Map<number, number>> {
  const auth = await requireSession();
  const now = Date.now();
  const tz = appTimeZone();
  const since = new Date(startOfLocalDay(now, tz));
  const sessions = await getDb()
    .select({ session: engineSessions })
    .from(engineSessions)
    .innerJoin(machines, eq(machines.id, engineSessions.machineId))
    .where(
      and(
        machineScope(auth),
        or(isNull(engineSessions.endedAt), gte(engineSessions.endedAt, since)),
      ),
    )
    .then((rows) => rows.map((r) => r.session));
  const byMachine = Map.groupBy(sessions, (s) => s.machineId);
  return new Map([...byMachine].map(([id, list]) => [id, hoursByDay(list, now, 1, tz)[0].hours]));
}

/** Engine hours for each of the last `days` days for one machine. */
export async function engineHoursByDay(id: number, days = 7) {
  await requireMachine(id);
  const now = Date.now();
  const tz = appTimeZone();
  const sessions = await sessionsSince(new Date(startOfLocalDay(now, tz, days - 1)), id);
  return hoursByDay(sessions, now, days, tz);
}

export async function recentEngineSessions(id: number, limit = 10) {
  await requireMachine(id);
  return getDb()
    .select()
    .from(engineSessions)
    .where(eq(engineSessions.machineId, id))
    .orderBy(desc(engineSessions.startedAt))
    .limit(limit);
}

/** The organization's machines, with the device currently on each (null if none). */
export async function listMachines() {
  const auth = await requireSession();
  const rows = await getDb()
    .select({ machine: machines, deviceId: deviceAssignments.deviceId, divisionName: divisions.name })
    .from(machines)
    .leftJoin(deviceAssignments, currentDevice)
    .leftJoin(divisions, eq(divisions.id, machines.divisionId))
    .where(machineScope(auth));
  // Unit number first (numerically where possible), as fleet managers refer to machines by unit.
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return rows
    .map((r) => ({ ...r.machine, deviceId: r.deviceId, divisionName: r.divisionName }))
    .sort((a, b) =>
      a.unitNumber && b.unitNumber
        ? collator.compare(a.unitNumber, b.unitNumber)
        : a.unitNumber
          ? -1
          : b.unitNumber
            ? 1
            : collator.compare(a.name, b.name),
    );
}

/** The machine, or null if it doesn't exist or belongs to another organization. */
export async function getMachine(id: number) {
  const auth = await requireSession();
  return machineInScope(id, auth);
}

/** Old links used the device ID, which became the machine's QR code: find the machine by code. */
export async function machineIdForCode(code: string) {
  const auth = await requireSession();
  const [row] = await getDb()
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.code, code), machineScope(auth)));
  return row?.id ?? null;
}

/** The devices that have been on a machine, newest first (the open one is the current device). */
export async function machineDevices(id: number) {
  await requireMachine(id);
  return getDb()
    .select({
      deviceId: deviceAssignments.deviceId,
      startedAt: deviceAssignments.startedAt,
      endedAt: deviceAssignments.endedAt,
      lastSeenAt: devices.lastSeenAt,
      lastBatteryV: devices.lastBatteryV,
      lastRssi: devices.lastRssi,
    })
    .from(deviceAssignments)
    .innerJoin(devices, eq(devices.id, deviceAssignments.deviceId))
    .where(eq(deviceAssignments.machineId, id))
    .orderBy(desc(deviceAssignments.startedAt));
}

export async function getTrack(id: number, hours = 24, limit = 2000) {
  await requireMachine(id);
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await getDb()
    .select({ lat: telemetry.lat, lng: telemetry.lng, at: telemetry.receivedAt })
    .from(telemetry)
    .where(and(eq(telemetry.machineId, id), gte(telemetry.receivedAt, since), isNotNull(telemetry.lat)))
    .orderBy(desc(telemetry.receivedAt))
    .limit(limit);
  return rows.reverse().map((r) => ({ lat: r.lat!, lng: r.lng!, at: r.at }));
}

export async function getRecentTelemetry(id: number, limit = 1) {
  await requireMachine(id);
  return getDb()
    .select()
    .from(telemetry)
    .where(eq(telemetry.machineId, id))
    .orderBy(desc(telemetry.receivedAt), desc(telemetry.id))
    .limit(limit);
}

export async function getRecentEvents(id: number, limit = 20) {
  await requireMachine(id);
  return getDb()
    .select()
    .from(deviceEvents)
    .where(eq(deviceEvents.machineId, id))
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
      .select({ operatorId: machineOperators.operatorId, machineId: machines.id, name: machines.name, unitNumber: machines.unitNumber })
      .from(machineOperators)
      .innerJoin(machines, eq(machines.id, machineOperators.machineId))
      .where(machineScope(auth)),
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
export async function allowedOperatorIds(machineId: number) {
  await requireMachine(machineId);
  const rows = await getDb()
    .select({ id: machineOperators.operatorId })
    .from(machineOperators)
    .where(eq(machineOperators.machineId, machineId));
  return rows.map((r) => r.id);
}

const checkinWithOperator = {
  id: checkins.id,
  machineId: checkins.machineId,
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

/** The operator currently checked in on each machine, keyed by machine ID. */
export async function currentCheckins() {
  const auth = await requireSession();
  const rows = await getDb()
    .select(checkinWithOperator)
    .from(checkins)
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .innerJoin(machines, eq(machines.id, checkins.machineId))
    .where(and(eq(checkins.organizationId, auth.organizationId), machineScope(auth), isNull(checkins.endedAt)));
  return new Map((await withEngine(rows)).filter((r) => r.current).map((r) => [r.machineId, r]));
}

export async function recentCheckins(machineId: number, limit = 10) {
  const auth = await requireMachine(machineId);
  const rows = await getDb()
    .select(checkinWithOperator)
    .from(checkins)
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .where(and(eq(checkins.machineId, machineId), eq(checkins.organizationId, auth.organizationId)))
    .orderBy(desc(checkins.startedAt))
    .limit(limit);
  return withEngine(rows);
}

// ---------- Alerts ----------

const alertWithMachine = {
  id: alerts.id,
  machineId: alerts.machineId,
  machineName: machines.name,
  unitNumber: machines.unitNumber,
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
export async function openAlerts(machineId?: number) {
  const auth = await requireSession();
  return getDb()
    .select(alertWithMachine)
    .from(alerts)
    .innerJoin(machines, eq(machines.id, alerts.machineId))
    .where(
      and(
        eq(alerts.organizationId, auth.organizationId),
        machineScope(auth),
        isNull(alerts.acknowledgedAt),
        machineId ? eq(alerts.machineId, machineId) : undefined,
      ),
    )
    .orderBy(desc(alerts.createdAt));
}

export async function acknowledgedAlerts(limit = 30, machineId?: number) {
  const auth = await requireSession();
  return getDb()
    .select(alertWithMachine)
    .from(alerts)
    .innerJoin(machines, eq(machines.id, alerts.machineId))
    .where(
      and(
        eq(alerts.organizationId, auth.organizationId),
        machineScope(auth),
        isNotNull(alerts.acknowledgedAt),
        machineId ? eq(alerts.machineId, machineId) : undefined,
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
    .innerJoin(machines, eq(machines.id, alerts.machineId))
    .where(and(eq(alerts.organizationId, auth.organizationId), machineScope(auth), isNull(alerts.acknowledgedAt)));
  return row.count;
}

// ---------- Alert subscriptions ----------

/**
 * One user's alert subscriptions and what they can choose from (only machines and divisions they can
 * see). Everyone manages their own; owners can manage anyone's in their organization. Null if not allowed.
 */
export async function subscriptionSettings(userId?: number) {
  const auth = await requireSession();
  const db = getDb();
  const editingOther = userId !== undefined && userId !== auth.userId;
  if (editingOther && !hasRole(auth, "owner")) return null;
  // Your own subscriptions live in your own organization (platform admins may be viewing another one).
  const organizationId = editingOther ? auth.organizationId : auth.homeOrganizationId;
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, editingOther ? userId : auth.userId), eq(users.organizationId, organizationId)));
  if (!user) return null;
  const scope = await scopeOfUser(db, user);
  const [subscriptions, divisionChoices, machineChoices] = await Promise.all([
    listSubscriptions(db, organizationId, user.id),
    db
      .select({ id: divisions.id, name: divisions.name })
      .from(divisions)
      .where(
        and(eq(divisions.organizationId, organizationId), scope.divisionIds ? inArray(divisions.id, scope.divisionIds) : undefined),
      )
      .orderBy(asc(divisions.name)),
    db
      .select({ id: machines.id, name: machines.name, unitNumber: machines.unitNumber })
      .from(machines)
      .where(machineScope(scope))
      .orderBy(asc(machines.unitNumber), asc(machines.name)),
  ]);
  return { user, isSelf: !editingOther, subscriptions, divisions: divisionChoices, machines: machineChoices };
}

// ---------- Organization users (owners manage them) ----------

export async function listUsers() {
  await connection();
  const auth = await requireRoleForPage("owner");
  const db = getDb();
  const [people, limits] = await Promise.all([
    db.select().from(users).where(eq(users.organizationId, auth.organizationId)).orderBy(desc(users.active), asc(users.email)),
    db
      .select({ userId: userDivisions.userId, divisionId: userDivisions.divisionId })
      .from(userDivisions)
      .innerJoin(users, eq(users.id, userDivisions.userId))
      .where(eq(users.organizationId, auth.organizationId)),
  ]);
  const byUser = Map.groupBy(limits, (l) => l.userId);
  return people.map((u) => ({ ...u, divisionIds: (byUser.get(u.id) ?? []).map((l) => l.divisionId) }));
}

/**
 * The organization's divisions with how many machines and limited users each has. Users limited to
 * some divisions only get theirs (for choosing a machine's division).
 */
export async function listDivisions() {
  const auth = await requireSession();
  const db = getDb();
  const [rows, machineCounts, userCounts] = await Promise.all([
    db
      .select()
      .from(divisions)
      .where(
        and(
          eq(divisions.organizationId, auth.organizationId),
          auth.divisionIds ? inArray(divisions.id, auth.divisionIds) : undefined,
        ),
      )
      .orderBy(asc(divisions.name)),
    db
      .select({ divisionId: machines.divisionId, n: sql<number>`count(*)::int` })
      .from(machines)
      .where(eq(machines.organizationId, auth.organizationId))
      .groupBy(machines.divisionId),
    db
      .select({ divisionId: userDivisions.divisionId, n: sql<number>`count(*)::int` })
      .from(userDivisions)
      .groupBy(userDivisions.divisionId),
  ]);
  const m = new Map(machineCounts.map((c) => [c.divisionId, c.n]));
  const u = new Map(userCounts.map((c) => [c.divisionId, c.n]));
  return rows.map((d) => ({ ...d, machines: m.get(d.id) ?? 0, users: u.get(d.id) ?? 0 }));
}

// ---------- Platform admin (Veristart staff) ----------

export async function listOrganizations() {
  await connection();
  await requirePlatformAdmin();
  const db = getDb();
  const [orgs, counts, userCounts] = await Promise.all([
    db.select().from(organizations).orderBy(asc(organizations.name)),
    db
      .select({ organizationId: machines.organizationId, n: sql<number>`count(*)::int` })
      .from(machines)
      .groupBy(machines.organizationId),
    db
      .select({ organizationId: users.organizationId, n: sql<number>`count(*)::int` })
      .from(users)
      .groupBy(users.organizationId),
  ]);
  const machineCounts = new Map(counts.map((c) => [c.organizationId, c.n]));
  const people = new Map(userCounts.map((c) => [c.organizationId, c.n]));
  return orgs.map((o) => ({ ...o, machines: machineCounts.get(o.id) ?? 0, users: people.get(o.id) ?? 0 }));
}

/**
 * Every device, with whose stock it's in and the machine it's on (if any), for pairing. Devices
 * not in anyone's stock (new or returned) come first, then by most recently heard from.
 */
export async function allDevices() {
  await connection();
  await requirePlatformAdmin();
  const rows = await getDb()
    .select({
      device: devices,
      stockOrganization: organizations.name,
      machineId: machines.id,
      machineName: machines.name,
      unitNumber: machines.unitNumber,
    })
    .from(devices)
    .leftJoin(organizations, eq(organizations.id, devices.organizationId))
    .leftJoin(deviceAssignments, and(eq(deviceAssignments.deviceId, devices.id), isNull(deviceAssignments.endedAt)))
    .leftJoin(machines, eq(machines.id, deviceAssignments.machineId))
    .orderBy(sql`${devices.organizationId} is not null`, desc(devices.lastSeenAt));
  return rows.map((r) => ({ ...r.device, stockOrganization: r.stockOrganization, machine: r.machineId ? { id: r.machineId, name: r.machineName!, unitNumber: r.unitNumber } : null }));
}

/** Staff: devices that could go on one of this organization's machines (unpaired, in Veristart's or their stock). */
export async function pairableDevices(organizationId: number) {
  await connection();
  await requirePlatformAdmin();
  return getDb()
    .select({ id: devices.id, organizationId: devices.organizationId, lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .leftJoin(deviceAssignments, and(eq(deviceAssignments.deviceId, devices.id), isNull(deviceAssignments.endedAt)))
    .where(and(isNull(deviceAssignments.id), or(isNull(devices.organizationId), eq(devices.organizationId, organizationId))))
    .orderBy(desc(devices.lastSeenAt));
}

/** Machines with no device on them, across all organizations, for pairing. */
export async function machinesWithoutDevice() {
  await connection();
  await requirePlatformAdmin();
  return getDb()
    .select({ id: machines.id, name: machines.name, unitNumber: machines.unitNumber, organizationId: machines.organizationId, organizationName: organizations.name })
    .from(machines)
    .innerJoin(organizations, eq(organizations.id, machines.organizationId))
    .leftJoin(deviceAssignments, currentDevice)
    .where(isNull(deviceAssignments.id))
    .orderBy(asc(organizations.name), asc(machines.name));
}

/** Staff: one device's diagnostics, whatever machine or organization it's with. */
export async function getDeviceForStaff(id: string) {
  await connection();
  await requirePlatformAdmin();
  const db = getDb();
  const [row] = await db
    .select({ device: devices, stockOrganization: organizations.name })
    .from(devices)
    .leftJoin(organizations, eq(organizations.id, devices.organizationId))
    .where(eq(devices.id, id));
  if (!row) return null;
  const [pairings, events, [latest]] = await Promise.all([
    db
      .select({
        machineId: machines.id,
        machineName: machines.name,
        unitNumber: machines.unitNumber,
        organizationName: organizations.name,
        startedAt: deviceAssignments.startedAt,
        endedAt: deviceAssignments.endedAt,
      })
      .from(deviceAssignments)
      .innerJoin(machines, eq(machines.id, deviceAssignments.machineId))
      .innerJoin(organizations, eq(organizations.id, machines.organizationId))
      .where(eq(deviceAssignments.deviceId, id))
      .orderBy(desc(deviceAssignments.startedAt)),
    db.select().from(deviceEvents).where(eq(deviceEvents.deviceId, id)).orderBy(desc(deviceEvents.at)).limit(20),
    db.select().from(telemetry).where(eq(telemetry.deviceId, id)).orderBy(desc(telemetry.receivedAt), desc(telemetry.id)).limit(1),
  ]);
  return { ...row.device, stockOrganization: row.stockOrganization, pairings, events, latest: latest ?? null };
}

/** Platform admins: organization names for the switcher in the nav bar. */
export async function listOrganizationsForSwitcher() {
  await connection();
  await requirePlatformAdmin();
  return getDb().select({ id: organizations.id, name: organizations.name }).from(organizations).orderBy(asc(organizations.name));
}
