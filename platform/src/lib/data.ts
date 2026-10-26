import "server-only";
import { checklistResultById, parseResultFilters, queryChecklistResults } from "@/lib/checklist-results";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { connection } from "next/server";
import { cache } from "react";
import { getDb } from "@/lib/db";
import {
  alerts,
  certificationTypes,
  checkinPhotos,
  checkins,
  checklistAnswerSets,
  checklistIssues,
  checklistTemplates,
  deviceAssignments,
  deviceDiagnostics,
  deviceEvents,
  deviceIncidents,
  devices,
  divisions,
  engineSessions,
  fuelEvents,
  machineCategories,
  machineFaults,
  machineOperators,
  machines,
  operators,
  organizations,
  telemetry,
  trainingRecords,
  userDivisions,
  users,
  worksites,
  worksiteVisits,
} from "@/lib/db/schema";
import { machineScope, type Scope } from "@/lib/divisions";
import { getRule, listRules, recentActivity, scopeOfUser } from "@/lib/notifications";
import { ensureChecklistDefaults } from "@/lib/checklists";
import { auditEntries } from "@/lib/privacy";
import { buildReport, reportRange } from "@/lib/reports";
import { commandHistory, deviceKey } from "@/lib/commands";
import { listReleases, releaseRollout } from "@/lib/firmware";
import { listBreaches } from "@/lib/breaches";
import { modeHistory } from "@/lib/modes";
import { allowedActions, canManageSchedule, listSchedules } from "@/lib/schedules";
import { currentMode } from "@/lib/mode-types";
import { ensureTrainingDefaults, latestRecords, recordStatus } from "@/lib/training";
import { todayIn } from "@/lib/schedule-time";
import { scanAvailable } from "@/lib/scan";
import { locationHistory, voltageHistory } from "@/lib/history";
import { historyRange } from "@/lib/history-track";
import { onRoadMachineCount, roadCoverageByMonth } from "@/lib/posted-speed";
import { hasRole } from "@/lib/auth";
import { automaticEnd, checkinEngine, engineStoppedAt, type CheckinEngine } from "@/lib/operators";
import { hoursByDay, startOfLocalDay } from "@/lib/telemetry/engine";
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

// The pure rule lives with the engine thresholds (tested there); pages import it from here.
export { engineStatus, type EngineStatus } from "@/lib/telemetry/engine";

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
  const tz = (await requireSession()).timeZone;
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

/**
 * Schedules page and form: every schedule (with whether this user may change it), the machines this user can
 * schedule (with their mode now), operators, the fleet timezone and the conflict rule.
 */
export async function schedulesData() {
  const auth = await requireSession();
  const db = getDb();
  const [list, mine, allMachines, ops, [org]] = await Promise.all([
    listSchedules(db, auth.organizationId),
    db.select().from(machines).where(machineScope(auth)).orderBy(asc(machines.unitNumber), asc(machines.name)),
    db.select({ id: machines.id, name: machines.name, unitNumber: machines.unitNumber, divisionId: machines.divisionId }).from(machines).where(eq(machines.organizationId, auth.organizationId)),
    db.select({ id: operators.id, name: operators.name }).from(operators).where(and(eq(operators.organizationId, auth.organizationId), eq(operators.active, true))).orderBy(asc(operators.name)),
    db.select({ timezone: organizations.timezone, rule: organizations.scheduleConflictRule }).from(organizations).where(eq(organizations.id, auth.organizationId)),
  ]);
  const divisionOf = new Map(allMachines.map((m) => [m.id, m.divisionId]));
  const now = Date.now();
  return {
    schedules: list.map((s) => ({ ...s, canManage: canManageSchedule(auth, s, divisionOf) })),
    machines: mine.map((m) => ({ id: m.id, name: m.unitNumber ? `Unit ${m.unitNumber} · ${m.name}` : m.name, tier: m.tier, mode: currentMode(m, now) })),
    /** Names of every machine, for describing schedules (including machines outside this user's divisions). */
    machineNames: allMachines.map((m) => ({ id: m.id, name: m.unitNumber ? `Unit ${m.unitNumber} · ${m.name}` : m.name })),
    operators: ops,
    actions: allowedActions(auth),
    wholeOrganization: auth.divisionIds === null,
    fleetTimezone: org?.timezone ?? "America/Toronto",
    conflictRule: (org?.rule === "most_restrictive" ? "most_restrictive" : "least_restrictive") as "least_restrictive" | "most_restrictive",
  };
}

/** A machine's recent operating-mode changes. */
export async function machineModeHistory(id: number) {
  await requireMachine(id);
  return modeHistory(getDb(), id);
}

/** Engine hours for each of the last `days` days for one machine. */
export async function engineHoursByDay(id: number, days = 7) {
  await requireMachine(id);
  const now = Date.now();
  const tz = (await requireSession()).timeZone;
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
    .select({ lat: telemetry.lat, lng: telemetry.lng, at: telemetry.recordedAt })
    .from(telemetry)
    .where(and(eq(telemetry.machineId, id), gte(telemetry.recordedAt, since), isNotNull(telemetry.lat)))
    .orderBy(desc(telemetry.recordedAt), desc(telemetry.id))
    .limit(limit);
  return rows.reverse().map((r) => ({ lat: r.lat!, lng: r.lng!, at: r.at }));
}

export async function getRecentTelemetry(id: number, limit = 1) {
  await requireMachine(id);
  return getDb()
    .select()
    .from(telemetry)
    .where(eq(telemetry.machineId, id))
    .orderBy(desc(telemetry.recordedAt), desc(telemetry.id))
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
  checklistFromCheckinId: checkins.checklistFromCheckinId,
  lockoutRequested: checkins.lockoutRequested,
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
  const photos = rows.length
    ? await getDb()
        .select({ id: checkinPhotos.id, checkinId: checkinPhotos.checkinId, questionId: checkinPhotos.questionId })
        .from(checkinPhotos)
        .where(inArray(checkinPhotos.checkinId, rows.map((r) => r.id)))
        .orderBy(checkinPhotos.id)
    : [];
  const byCheckin = Map.groupBy(photos, (p) => p.checkinId);
  return (await withEngine(rows)).map((r) => ({ ...r, photos: byCheckin.get(r.id) ?? [] }));
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

// ---------- Checklists ----------

/**
 * Who may change checklist templates and answer sets: managers and owners who see the whole
 * organization (templates are shared by every division).
 */
export async function canEditChecklists() {
  const auth = await requireSession();
  return hasRole(auth, "manager") && auth.divisionIds === null;
}

// ---------- Engine computer (J1939) ----------

/** The latest engine computer readings and the fault codes (active first, then recent) for a machine. */
export async function machineEngineData(machineId: number) {
  await requireMachine(machineId);
  const db = getDb();
  const [[latest], faults] = await Promise.all([
    db
      .select({ receivedAt: telemetry.receivedAt, fields: telemetry.fields })
      .from(telemetry)
      .where(and(eq(telemetry.machineId, machineId), sql`(${telemetry.fields} ? 'j1939EngineHours' or ${telemetry.fields} ? 'j1939Rpm' or ${telemetry.fields} ? 'j1939Faults')`))
      .orderBy(desc(telemetry.receivedAt))
      .limit(1),
    db
      .select()
      .from(machineFaults)
      .where(eq(machineFaults.machineId, machineId))
      .orderBy(sql`${machineFaults.clearedAt} is null desc`, desc(machineFaults.lastSeenAt))
      .limit(15),
  ]);
  return { latest: latest ?? null, faults };
}

/** The latest tank level and the fuel log (refuels, suspected thefts) for a machine. */
export async function machineFuel(machineId: number, limit = 12) {
  await requireMachine(machineId);
  const db = getDb();
  const level = sql<number>`coalesce(${telemetry.fields}->>'j1939FuelLevelPct', ${telemetry.fields}->>'obdFuelLevelPct')::float`;
  const [[latest], log] = await Promise.all([
    db
      .select({ pct: level, at: telemetry.receivedAt })
      .from(telemetry)
      .where(and(eq(telemetry.machineId, machineId), sql`(${telemetry.fields} ? 'j1939FuelLevelPct' or ${telemetry.fields} ? 'obdFuelLevelPct')`))
      .orderBy(desc(telemetry.receivedAt))
      .limit(1),
    db.select().from(fuelEvents).where(eq(fuelEvents.machineId, machineId)).orderBy(desc(fuelEvents.at)).limit(limit),
  ]);
  return { latest: latest ? { pct: Number(latest.pct), at: latest.at } : null, log };
}

/** Active fault code counts per machine (fleet list). */
export async function activeFaultCounts() {
  const auth = await requireSession();
  const rows = await getDb()
    .select({ machineId: machineFaults.machineId, count: sql<number>`count(*)`.mapWith(Number) })
    .from(machineFaults)
    .innerJoin(machines, eq(machines.id, machineFaults.machineId))
    .where(and(isNull(machineFaults.clearedAt), machineScope(auth)))
    .groupBy(machineFaults.machineId);
  return new Map(rows.map((r) => [r.machineId, r.count]));
}

// ---------- Reports ----------

/** Report data for the Reports page and CSV downloads: the signed-in user's machines (optionally one division). */
export async function reportData(params: { range?: string; from?: string; to?: string; division?: string }) {
  const auth = await requireSession();
  const db = getDb();
  const tz = (await requireSession()).timeZone;
  const divisionChoices = await db
    .select({ id: divisions.id, name: divisions.name })
    .from(divisions)
    .where(and(eq(divisions.organizationId, auth.organizationId), auth.divisionIds ? inArray(divisions.id, auth.divisionIds) : undefined))
    .orderBy(asc(divisions.name));
  const divisionId = divisionChoices.find((d) => String(d.id) === params.division)?.id ?? null;
  const now = Date.now();
  const report = await buildReport(db, auth, reportRange(params, now, tz), tz, { divisionId, now });
  return { report, divisions: divisionChoices, divisionId, timeZone: tz, now };
}

// ---------- Checklist results ----------

/** Filter choices for checklist results: divisions and machines the user can see, and the organization's operators. */
async function resultChoices(auth: AuthContext) {
  const db = getDb();
  const [divisionChoices, machineChoices, operatorChoices] = await Promise.all([
    db
      .select({ id: divisions.id, name: divisions.name })
      .from(divisions)
      .where(and(eq(divisions.organizationId, auth.organizationId), auth.divisionIds ? inArray(divisions.id, auth.divisionIds) : undefined))
      .orderBy(asc(divisions.name)),
    db
      .select({ id: machines.id, name: machines.name, unitNumber: machines.unitNumber })
      .from(machines)
      .where(and(eq(machines.organizationId, auth.organizationId), machineScope(auth)))
      .orderBy(asc(machines.name)),
    db.select({ id: operators.id, name: operators.name }).from(operators).where(eq(operators.organizationId, auth.organizationId)).orderBy(asc(operators.name)),
  ]);
  return { divisions: divisionChoices, machines: machineChoices, operators: operatorChoices };
}

/** Pre-start checklist results (src/lib/checklist-results.ts): one page, the filters and their choices. */
export async function checklistResults(params: Record<string, string | undefined>) {
  const auth = await requireSession();
  const now = Date.now();
  const filters = parseResultFilters(params, now, auth.timeZone);
  const [page, choices] = await Promise.all([queryChecklistResults(getDb(), auth.organizationId, auth, filters), resultChoices(auth)]);
  return { ...page, filters, choices, timeZone: auth.timeZone, now };
}

/** One checklist result, or null if it isn't this user's to see. */
export async function checklistResult(id: number) {
  const auth = await requireSession();
  const result = await checklistResultById(getDb(), auth.organizationId, auth, id);
  return result ? { result, timeZone: auth.timeZone, now: Date.now() } : null;
}

/** All matching results (up to `limit`) for the CSV and the printable report, with the times of covering checklists. */
export async function checklistResultsForExport(params: Record<string, string | undefined>, limit: number) {
  const auth = await requireSession();
  const now = Date.now();
  const filters = parseResultFilters(params, now, auth.timeZone);
  const db = getDb();
  const { rows, total } = await queryChecklistResults(db, auth.organizationId, auth, filters, { limit, offset: 0 });
  const coveringIds = [...new Set(rows.map((r) => r.checklistFromCheckinId).filter((v): v is number => v !== null))];
  const covering = coveringIds.length
    ? await db
        .select({ id: checkins.id, startedAt: checkins.startedAt })
        .from(checkins)
        .where(and(inArray(checkins.id, coveringIds), eq(checkins.organizationId, auth.organizationId)))
    : [];
  return { rows, total, filters, timeZone: auth.timeZone, now, coveringTimes: new Map(covering.map((c) => [c.id, c.startedAt])) };
}

// ---------- Worksites ----------

/** Drawing and changing worksites: managers and owners who see the whole organization (sites are org-wide). */
export const canEditWorksites = canEditChecklists;

/** Worksites with the machines in them right now (only machines the user can see). */
export async function listWorksites() {
  const auth = await requireSession();
  const db = getDb();
  const [sites, inside, fleet] = await Promise.all([
    db.select().from(worksites).where(eq(worksites.organizationId, auth.organizationId)).orderBy(asc(worksites.name)),
    db
      .select({ worksiteId: worksiteVisits.worksiteId, enteredAt: worksiteVisits.enteredAt, machine: machines })
      .from(worksiteVisits)
      .innerJoin(machines, eq(machines.id, worksiteVisits.machineId))
      .where(and(isNull(worksiteVisits.leftAt), machineScope(auth))),
    db
      .select({ id: machines.id, name: machines.name, unitNumber: machines.unitNumber, lat: machines.lastLat, lng: machines.lastLng, lastSeenAt: machines.lastSeenAt })
      .from(machines)
      .where(and(machineScope(auth), isNotNull(machines.lastLat))),
  ]);
  const insideBySite = Map.groupBy(inside, (v) => v.worksiteId);
  return {
    sites: sites.map((site) => ({
      ...site,
      machinesInside: (insideBySite.get(site.id) ?? []).map((v) => ({ id: v.machine.id, name: v.machine.name, unitNumber: v.machine.unitNumber, since: v.enteredAt })),
    })),
    machines: fleet,
  };
}

/** Outlines for the fleet and machine maps. */
export async function worksiteOutlines() {
  const auth = await requireSession();
  return getDb()
    .select({ id: worksites.id, name: worksites.name, type: worksites.type, polygon: worksites.polygon })
    .from(worksites)
    .where(eq(worksites.organizationId, auth.organizationId));
}

/** The worksites a machine is in now, and its recent visits. */
export async function machineWorksiteVisits(machineId: number, limit = 8) {
  await requireMachine(machineId);
  return getDb()
    .select({ visit: worksiteVisits, name: worksites.name, type: worksites.type })
    .from(worksiteVisits)
    .innerJoin(worksites, eq(worksites.id, worksiteVisits.worksiteId))
    .where(eq(worksiteVisits.machineId, machineId))
    .orderBy(desc(worksiteVisits.enteredAt))
    .limit(limit);
}

/** Exporting and erasing operators' data: the same people as checklists (they see every machine an operator used). */
export const canManageOperatorData = canEditChecklists;

/** Owners: the privacy contact, retention settings and the audit log (Settings page). */
export async function privacySettings() {
  await connection();
  const auth = await requireRoleForPage("owner");
  const db = getDb();
  const [[org], log] = await Promise.all([
    db.select().from(organizations).where(eq(organizations.id, auth.organizationId)),
    auditEntries(db, auth.organizationId),
  ]);
  return { org, log };
}

/** The organization's checklists (with how many machines use each) and answer sets. */
export async function checklistSettings() {
  const auth = await requireSession();
  const db = getDb();
  await ensureChecklistDefaults(db, auth.organizationId);
  const [templates, sets, usage, machineCount] = await Promise.all([
    db
      .select({ template: checklistTemplates, answerSetName: checklistAnswerSets.name })
      .from(checklistTemplates)
      .innerJoin(checklistAnswerSets, eq(checklistAnswerSets.id, checklistTemplates.answerSetId))
      .where(eq(checklistTemplates.organizationId, auth.organizationId))
      .orderBy(desc(checklistTemplates.isDefault), asc(checklistTemplates.name)),
    db.select().from(checklistAnswerSets).where(eq(checklistAnswerSets.organizationId, auth.organizationId)).orderBy(asc(checklistAnswerSets.name)),
    db
      .select({ templateId: machines.checklistTemplateId, n: sql<number>`count(*)::int` })
      .from(machines)
      .where(eq(machines.organizationId, auth.organizationId))
      .groupBy(machines.checklistTemplateId),
    db.select({ n: sql<number>`count(*)::int` }).from(machines).where(eq(machines.organizationId, auth.organizationId)),
  ]);
  const byTemplate = new Map(usage.map((u) => [u.templateId, u.n]));
  const assigned = usage.filter((u) => u.templateId !== null).reduce((sum, u) => sum + u.n, 0);
  return {
    templates: templates.map(({ template, answerSetName }) => ({
      ...template,
      answerSetName,
      questionCount: template.sections.reduce((n, sec) => n + sec.questions.length, 0),
      // Machines without their own checklist use the default.
      machines: (byTemplate.get(template.id) ?? 0) + (template.isDefault ? machineCount[0].n - assigned : 0),
    })),
    answerSets: sets.map((set) => ({ ...set, usedBy: templates.filter((t) => t.template.answerSetId === set.id).length })),
  };
}

export async function getChecklistTemplate(id: number) {
  const auth = await requireSession();
  const [row] = await getDb()
    .select()
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.id, id), eq(checklistTemplates.organizationId, auth.organizationId)));
  return row ?? null;
}

export async function getAnswerSet(id: number) {
  const auth = await requireSession();
  const [row] = await getDb()
    .select()
    .from(checklistAnswerSets)
    .where(and(eq(checklistAnswerSets.id, id), eq(checklistAnswerSets.organizationId, auth.organizationId)));
  return row ?? null;
}

/** A machine's checklist, the choices for it, and its checklist issues (open first, then recently resolved). */
export async function machineChecklist(machineId: number) {
  const auth = await requireMachine(machineId);
  const db = getDb();
  await ensureChecklistDefaults(db, auth.organizationId);
  const [templates, issues] = await Promise.all([
    db
      .select({ id: checklistTemplates.id, name: checklistTemplates.name, isDefault: checklistTemplates.isDefault })
      .from(checklistTemplates)
      .where(eq(checklistTemplates.organizationId, auth.organizationId))
      .orderBy(asc(checklistTemplates.name)),
    db
      .select()
      .from(checklistIssues)
      .where(eq(checklistIssues.machineId, machineId))
      .orderBy(sql`${checklistIssues.resolvedAt} is not null`, desc(checklistIssues.lastReportedAt))
      .limit(30),
  ]);
  // Photos of each issue's item, taken while it was being reported.
  const photos = issues.length
    ? await db
        .select({ id: checkinPhotos.id, questionId: checkinPhotos.questionId, takenAt: checkinPhotos.takenAt })
        .from(checkinPhotos)
        .where(and(eq(checkinPhotos.machineId, machineId), inArray(checkinPhotos.questionId, [...new Set(issues.map((i) => i.questionId))])))
        .orderBy(desc(checkinPhotos.takenAt))
        .limit(200)
    : [];
  return {
    templates,
    issues: issues.map((issue) => ({
      ...issue,
      photoIds: photos
        .filter((p) => p.questionId === issue.questionId && p.takenAt >= issue.firstReportedAt && p.takenAt <= issue.lastReportedAt)
        .slice(0, 6)
        .map((p) => p.id),
    })),
  };
}

// ---------- Tamper / connectivity ----------

/** A machine's recent device incidents (quiet spells, power cuts, moved while quiet…), newest first. */
export async function machineIncidents(machineId: number, limit = 10) {
  await requireMachine(machineId);
  return getDb()
    .select()
    .from(deviceIncidents)
    .where(eq(deviceIncidents.machineId, machineId))
    .orderBy(desc(deviceIncidents.openedAt))
    .limit(limit);
}

/** Machines whose device is quiet right now (open incidents), keyed by machine ID, for the Fleet page. */
export async function quietMachines() {
  const auth = await requireSession();
  const rows = await getDb()
    .select({ machineId: deviceIncidents.machineId, concern: deviceIncidents.concern })
    .from(deviceIncidents)
    .innerJoin(machines, eq(machines.id, deviceIncidents.machineId))
    .where(and(machineScope(auth), eq(deviceIncidents.kind, "silent"), isNull(deviceIncidents.resolvedAt)));
  return new Map(rows.map((r) => [r.machineId, r.concern]));
}

// ---------- Alert subscriptions ----------

/**
 * Whose notification subscriptions are being managed: your own (in your own organization, even if a
 * platform admin is viewing another), or, for owners, anyone's in the organization. Null if not allowed.
 */
async function subscriptionOwner(userId?: number) {
  const auth = await requireSession();
  const editingOther = userId !== undefined && userId !== auth.userId;
  if (editingOther && !hasRole(auth, "owner")) return null;
  const organizationId = editingOther ? auth.organizationId : auth.homeOrganizationId;
  const [user] = await getDb()
    .select()
    .from(users)
    .where(and(eq(users.id, editingOther ? userId : auth.userId), eq(users.organizationId, organizationId)));
  return user ? { user, isSelf: !editingOther } : null;
}

/** The subscriptions list page: rules plus the last day's events and what they matched. */
export async function subscriptionList(userId?: number) {
  const owner = await subscriptionOwner(userId);
  if (!owner) return null;
  const db = getDb();
  const [rules, activity, names] = await Promise.all([
    listRules(db, owner.user.organizationId, owner.user.id),
    recentActivity(db, owner.user),
    subscriptionChoices(owner.user),
  ]);
  return { ...owner, rules, activity, names };
}

/** The new/edit form: the rule (if editing) and what the user may choose from. */
export async function subscriptionForm(ruleId: number | null, userId?: number) {
  const owner = await subscriptionOwner(userId);
  if (!owner) return null;
  const rule = ruleId ? await getRule(getDb(), owner.user.organizationId, owner.user.id, ruleId) : null;
  if (ruleId && !rule) return null;
  return { ...owner, rule, choices: await subscriptionChoices(owner.user) };
}

/** Machines and divisions the user can see, and the organization's operators. */
async function subscriptionChoices(user: { id: number; organizationId: number; role: (typeof users.$inferSelect)["role"] }) {
  const db = getDb();
  const scope = await scopeOfUser(db, user);
  const [divisionRows, machineRows, operatorRows, worksiteRows] = await Promise.all([
    db
      .select({ id: divisions.id, name: divisions.name })
      .from(divisions)
      .where(
        and(eq(divisions.organizationId, user.organizationId), scope.divisionIds ? inArray(divisions.id, scope.divisionIds) : undefined),
      )
      .orderBy(asc(divisions.name)),
    db
      .select({ id: machines.id, name: machines.name, unitNumber: machines.unitNumber })
      .from(machines)
      .where(machineScope(scope))
      .orderBy(asc(machines.unitNumber), asc(machines.name)),
    db
      .select({ id: operators.id, name: operators.name, employeeNumber: operators.employeeNumber, active: operators.active })
      .from(operators)
      .where(eq(operators.organizationId, user.organizationId))
      .orderBy(desc(operators.active), asc(operators.name)),
    db
      .select({ id: worksites.id, name: worksites.name, type: worksites.type })
      .from(worksites)
      .where(eq(worksites.organizationId, user.organizationId))
      .orderBy(asc(worksites.name)),
  ]);
  return { divisions: divisionRows, machines: machineRows, operators: operatorRows, worksites: worksiteRows, timeZone: (await requireSession()).timeZone };
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
/** Staff: a device's command history and key (for flashing our firmware). */
export async function deviceCommandsForStaff(id: string) {
  await connection();
  await requirePlatformAdmin();
  return { history: await commandHistory(getDb(), id), key: deviceKey(id) };
}

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
  const [pairings, events, [latest], diagnostics] = await Promise.all([
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
    db.select().from(telemetry).where(eq(telemetry.deviceId, id)).orderBy(desc(telemetry.recordedAt), desc(telemetry.id)).limit(1),
    db.select().from(deviceDiagnostics).where(eq(deviceDiagnostics.deviceId, id)).orderBy(desc(deviceDiagnostics.receivedAt)).limit(10),
  ]);
  return { ...row.device, stockOrganization: row.stockOrganization, pairings, events, latest: latest ?? null, diagnostics };
}

/** Staff: the privacy breach register. */
export async function breachRegister() {
  await connection();
  await requirePlatformAdmin();
  return listBreaches(getDb());
}

/** Staff: firmware releases (Platform → Firmware). */
export async function firmwareReleasesForStaff() {
  await connection();
  await requirePlatformAdmin();
  return listReleases(getDb());
}

/** Staff: one release and every device's version and update state. */
export async function firmwareRolloutForStaff(id: number) {
  await connection();
  await requirePlatformAdmin();
  return releaseRollout(getDb(), id);
}

/** Platform admins: organization names for the switcher in the nav bar. */
export async function listOrganizationsForSwitcher() {
  await connection();
  await requirePlatformAdmin();
  return getDb().select({ id: organizations.id, name: organizations.name }).from(organizations).orderBy(asc(organizations.name));
}

/** Machine categories (created on first use), for the machine form and certification types. */
export async function listMachineCategories() {
  const auth = await requireSession();
  const db = getDb();
  await ensureTrainingDefaults(db, auth.organizationId);
  return db
    .select({ id: machineCategories.id, name: machineCategories.name })
    .from(machineCategories)
    .where(eq(machineCategories.organizationId, auth.organizationId))
    .orderBy(asc(machineCategories.sortOrder), asc(machineCategories.name));
}

/**
 * Training page: certification types, categories (with machine counts), machines (for "covers"), and each
 * operator's latest record of each certification with its status today (company timezone).
 */
export async function trainingData() {
  const auth = await requireSession();
  const db = getDb();
  await ensureTrainingDefaults(db, auth.organizationId);
  const org = auth.organizationId;
  const [types, cats, fleet, records, [settings]] = await Promise.all([
    db.select().from(certificationTypes).where(eq(certificationTypes.organizationId, org)).orderBy(desc(certificationTypes.active), asc(certificationTypes.name)),
    db.select().from(machineCategories).where(eq(machineCategories.organizationId, org)).orderBy(asc(machineCategories.sortOrder), asc(machineCategories.name)),
    db
      .select({ id: machines.id, name: machines.name, unitNumber: machines.unitNumber, categoryId: machines.categoryId })
      .from(machines)
      .where(eq(machines.organizationId, org))
      .orderBy(asc(machines.unitNumber), asc(machines.name)),
    db
      .select({ record: trainingRecords, operator: { id: operators.id, name: operators.name, employeeNumber: operators.employeeNumber, active: operators.active } })
      .from(trainingRecords)
      .innerJoin(operators, eq(operators.id, trainingRecords.operatorId))
      .where(and(eq(trainingRecords.organizationId, org), isNull(operators.erasedAt))),
    db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, org)),
  ]);
  const today = todayIn(settings?.timezone ?? "America/Toronto");
  const typeById = new Map(types.map((t) => [t.id, t]));
  const rows = latestRecords(records, (row) => row.record)
    .map(({ record, operator }) => {
      const type = typeById.get(record.certificationTypeId)!;
      return { record, operator, type, ...recordStatus(record, type, today) };
    })
    .sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9) || a.operator.name.localeCompare(b.operator.name));
  return {
    types,
    categories: cats.map((c) => ({ ...c, machineCount: fleet.filter((m) => m.categoryId === c.id).length })),
    machines: fleet.map((m) => ({ id: m.id, name: m.unitNumber ? `Unit ${m.unitNumber} · ${m.name}` : m.name, categoryId: m.categoryId })),
    rows,
    today,
    /** Certification types and categories: whole-company managers and owners (like checklists). */
    canEditTypes: hasRole(auth, "manager") && auth.divisionIds === null,
    canEditRecords: hasRole(auth, "manager"),
  };
}

/** One certification type, for its edit page. */
export async function getCertificationType(id: number) {
  const auth = await requireSession();
  const [row] = await getDb()
    .select()
    .from(certificationTypes)
    .where(and(eq(certificationTypes.id, id), eq(certificationTypes.organizationId, auth.organizationId)));
  return row ?? null;
}

/** An operator's training records (newest first) with today's status, and the certifications to choose from. */
export async function operatorTraining(operatorId: number) {
  const auth = await requireSession();
  const db = getDb();
  await ensureTrainingDefaults(db, auth.organizationId);
  const [types, records, [settings]] = await Promise.all([
    db.select().from(certificationTypes).where(eq(certificationTypes.organizationId, auth.organizationId)).orderBy(desc(certificationTypes.active), asc(certificationTypes.name)),
    db
      .select()
      .from(trainingRecords)
      .where(and(eq(trainingRecords.operatorId, operatorId), eq(trainingRecords.organizationId, auth.organizationId)))
      .orderBy(desc(trainingRecords.issuedOn)),
    db.select({ timezone: organizations.timezone, retainScanImages: organizations.retainScanImages }).from(organizations).where(eq(organizations.id, auth.organizationId)),
  ]);
  const today = todayIn(settings?.timezone ?? "America/Toronto");
  const typeById = new Map(types.map((t) => [t.id, t]));
  // A record replaced by a later one of the same certification is history, not "expired".
  const current = new Set(latestRecords(records, (r) => r).map((r) => r.id));
  return {
    types: types.map((t) => ({ id: t.id, name: t.name, validityMonths: t.validityMonths, active: t.active })),
    records: records.map((r) => {
      const type = typeById.get(r.certificationTypeId)!;
      return { ...r, typeName: type.name, replaced: !current.has(r.id), ...recordStatus(r, type, today) };
    }),
    canEdit: hasRole(auth, "manager"),
    /** Scan to fill (src/lib/scan.ts), when set up; keep the photo by default per the company setting. */
    scan: scanAvailable() ? { retain: settings?.retainScanImages ?? true } : undefined,
  };
}

/** Whether "Scan to fill" is set up (ANTHROPIC_API_KEY), for forms outside the training pages. */
/** The signed-in user's company time zone (Settings), for showing times and days on pages. */
export async function companyTimeZone() {
  return (await requireSession()).timeZone;
}

export async function scanEnabled() {
  await requireSession();
  return scanAvailable();
}

/** Battery voltage history for a machine's page (src/lib/history.ts), for ?battery=24h|7d|30d. */
export async function machineVoltage(id: number, range: string | undefined) {
  await requireMachine(id);
  const now = Date.now();
  const tz = (await requireSession()).timeZone;
  const r = historyRange({ range: range && ["24h", "7d", "30d"].includes(range) ? range : "7d" }, now, tz, "7d");
  return { range: r, timeZone: tz, history: await voltageHistory(getDb(), id, r.from, r.to, now) };
}

/** Location history and replay data for a machine (src/lib/history.ts). */
export async function machineLocationHistory(id: number, params: { range?: string; from?: string; to?: string }) {
  await requireMachine(id);
  const now = Date.now();
  const tz = (await requireSession()).timeZone;
  const r = historyRange(params, now, tz);
  return { range: r, timeZone: tz, history: await locationHistory(getDb(), id, r.from, r.to, now) };
}

/** Settings (owners): road kilometres with/without a known posted limit by month, and how many on-road machines. */
export async function postedLimitCoverage() {
  const auth = await requireRoleForPage("owner");
  const db = getDb();
  const [months, onRoad] = await Promise.all([roadCoverageByMonth(db, auth.organizationId), onRoadMachineCount(db, auth.organizationId)]);
  return { months, onRoad };
}
