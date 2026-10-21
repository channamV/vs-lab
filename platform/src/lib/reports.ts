import { and, asc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { alerts, checkins, divisions, engineSessions, machines, operators, organizations, telemetry, worksites, worksiteVisits } from "@/lib/db/schema";
import { machineScope, type Scope } from "@/lib/divisions";
import { effectiveEnd, localDateKey, midnightInZone, type SessionSpan } from "@/lib/telemetry/engine";

/**
 * Reports: equipment use (engine hours, idle, utilization), operators, pre-start checklist compliance and
 * worksites, for a date range in the company's time zone. Everything is worked out from what the devices
 * already send (engine on/off, GPS, speed, RPM where available), check-ins and worksite visits.
 * Definitions are in docs/reports.md and on the Reports page.
 */

export const REPORT_RULES = {
  /** Engine running below this RPM counts as idle (diesel idle is typically 650–900 rpm). */
  idleRpm: 1000,
  /** Without RPM: engine running and moving slower than this counts as idle. */
  idleSpeedKph: 1,
  /** Longest range a report can cover. */
  maxDays: 92,
};

// ---------- Date ranges ----------

export const RANGE_PRESETS = {
  today: "Today",
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  month: "This month",
  lastmonth: "Last month",
} as const;
export type RangePreset = keyof typeof RANGE_PRESETS | "custom";

export type ReportRange = {
  preset: RangePreset;
  /** Local dates, inclusive: YYYY-MM-DD. */
  fromDate: string;
  toDate: string;
  /** UTC instants: start of fromDate, and the end of toDate (or now, if that's sooner). */
  from: number;
  to: number;
  /** Every local date in the range, oldest first. */
  days: string[];
  label: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const parseDate = (key: string) => key.split("-").map(Number) as [number, number, number];
const addDays = (key: string, n: number) => {
  const [y, m, d] = parseDate(key);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const startOfDate = (key: string, tz: string) => midnightInZone(...parseDate(key), tz);

/** The range for a preset (default last 7 days) or custom from/to dates, in the time zone. */
export function reportRange(params: { range?: string; from?: string; to?: string }, now: number, tz: string): ReportRange {
  const today = localDateKey(now, tz);
  let preset: RangePreset = params.range && (params.range in RANGE_PRESETS || params.range === "custom") ? (params.range as RangePreset) : "7d";
  let fromDate: string;
  let toDate = today;
  switch (preset) {
    case "today":
      fromDate = today;
      break;
    case "14d":
    case "30d":
    case "90d":
    case "7d":
      fromDate = addDays(today, -(Number(preset.slice(0, -1)) - 1));
      break;
    case "month":
      fromDate = `${today.slice(0, 8)}01`;
      break;
    case "lastmonth": {
      const firstThis = `${today.slice(0, 8)}01`;
      toDate = addDays(firstThis, -1);
      fromDate = `${toDate.slice(0, 8)}01`;
      break;
    }
    case "custom": {
      const ok = params.from && params.to && DATE.test(params.from) && DATE.test(params.to);
      if (!ok) {
        preset = "7d";
        fromDate = addDays(today, -6);
      } else {
        fromDate = params.from! <= params.to! ? params.from! : params.to!;
        toDate = params.from! <= params.to! ? params.to! : params.from!;
        if (toDate > today) toDate = today;
        if (fromDate > toDate) fromDate = toDate;
        if (addDays(fromDate, REPORT_RULES.maxDays - 1) < toDate) fromDate = addDays(toDate, -(REPORT_RULES.maxDays - 1));
      }
      break;
    }
  }
  const days: string[] = [];
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) days.push(d);
  const from = startOfDate(fromDate, tz);
  const to = Math.min(startOfDate(addDays(toDate, 1), tz), now);
  const fmt = (key: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${key}T12:00:00Z`));
  const label = preset === "custom" ? `${fmt(fromDate)} – ${fmt(toDate)}` : RANGE_PRESETS[preset];
  return { preset, fromDate, toDate, from, to, days, label };
}

// ---------- Pure helpers (tested) ----------

/** Milliseconds of a time span falling on each local day of the range. */
export function splitByDay(start: number, end: number, range: Pick<ReportRange, "from" | "to" | "days">, tz: string): Map<string, number> {
  const result = new Map<string, number>();
  const s = Math.max(start, range.from);
  const e = Math.min(end, range.to);
  if (e <= s) return result;
  for (let i = 0; i < range.days.length; i++) {
    const dayStart = startOfDate(range.days[i], tz);
    const dayEnd = i + 1 < range.days.length ? startOfDate(range.days[i + 1], tz) : range.to;
    const ms = Math.min(e, dayEnd) - Math.max(s, dayStart);
    if (ms > 0) result.set(range.days[i], ms);
  }
  return result;
}

/** How long two sets of spans overlap, in ms (spans within each set don't overlap each other). */
export function overlapMs(a: [number, number][], b: [number, number][]): number {
  let total = 0;
  for (const [as, ae] of a) for (const [bs, be] of b) total += Math.max(0, Math.min(ae, be) - Math.max(as, bs));
  return total;
}

/** Planned working hours in the range: the company's hours per working day, on its working days (today counts). */
export function plannedHours(range: Pick<ReportRange, "days">, hoursPerDay: number, workingDays: number[]): number {
  return range.days.filter((d) => workingDays.includes(new Date(`${d}T12:00:00Z`).getUTCDay())).length * hoursPerDay;
}

// ---------- The report ----------

export type MachineReport = {
  id: number;
  name: string;
  unitNumber: string | null;
  machineType: string | null;
  divisionName: string | null;
  hours: number;
  idleHours: number;
  /** Hours with a checked-in operator. */
  coveredHours: number;
  hoursByDay: Record<string, number>;
  idleByDay: Record<string, number>;
  daysUsed: number;
  /** Days the engine ran that had at least one check-in. */
  daysWithCheckin: number;
  missedDays: string[];
  utilization: number | null;
  lastUsed: Date | null;
  checkins: number;
  checkinsWithDefects: number;
  startsWithoutCheckin: number;
  topWorksite: string | null;
  /** From the engine computer's own meters (J1939), when the machine reports them. */
  meterHours: number | null;
  fuelL: number | null;
};

export type OperatorReport = { id: number; name: string; hours: number; checkins: number; machines: number; days: number; defects: number };
export type WorksiteReport = {
  id: number;
  name: string;
  type: string;
  visits: number;
  machines: number;
  timeOnSiteHours: number;
  engineHours: number;
  avgVisitHours: number | null;
};

export type Report = {
  range: ReportRange;
  plannedHoursPerMachine: number;
  plannedHoursPerDay: number;
  workingDays: number[];
  machines: MachineReport[];
  operators: OperatorReport[];
  worksites: WorksiteReport[];
  totals: {
    hours: number;
    idleHours: number;
    coveredHours: number;
    machines: number;
    activeMachines: number;
    activeOperators: number;
    utilization: number | null;
    daysOperated: number;
    daysWithCheckin: number;
    checkins: number;
    checkinsWithDefects: number;
    startsWithoutCheckin: number;
    /** Machines reporting fuel (J1939), and their total. */
    fuelMachines: number;
    fuelL: number;
  };
};

const hoursOf = (ms: number) => ms / 3_600_000;

/** Builds every report section for the machines in `scope` (optionally one division). */
export async function buildReport(db: Db, scope: Scope, range: ReportRange, tz: string, opts: { divisionId?: number | null; now?: number } = {}): Promise<Report> {
  const now = opts.now ?? Date.now();
  const [org] = await db.select().from(organizations).where(eq(organizations.id, scope.organizationId));
  const where: SQL[] = [machineScope(scope)!];
  if (opts.divisionId) where.push(eq(machines.divisionId, opts.divisionId));
  const fleet = await db
    .select({ machine: machines, divisionName: divisions.name })
    .from(machines)
    .leftJoin(divisions, eq(divisions.id, machines.divisionId))
    .where(and(...where))
    .orderBy(asc(machines.unitNumber), asc(machines.name));
  const ids = fleet.map((f) => f.machine.id);
  const from = new Date(range.from);
  const to = new Date(range.to);
  const none = ids.length === 0;

  const [sessions, idleRows, checkinRows, unauthorized, visits, ecuRows] = await Promise.all([
    none
      ? []
      : db
          .select()
          .from(engineSessions)
          .where(
            and(
              inArray(engineSessions.machineId, ids),
              lt(engineSessions.startedAt, to),
              or(isNull(engineSessions.endedAt), gte(engineSessions.endedAt, from)),
            ),
          ),
    none
      ? []
      : db
          .select({
            machineId: telemetry.machineId,
            day: sql<string>`to_char(${telemetry.receivedAt} at time zone ${tz}, 'YYYY-MM-DD')`,
            on: sql<number>`count(*) filter (where ${telemetry.engineOn})`.mapWith(Number),
            idle: sql<number>`count(*) filter (where ${telemetry.engineOn} and case
              when coalesce(${telemetry.fields}->>'j1939Rpm', ${telemetry.fields}->>'obdRpm') is not null
                then coalesce(${telemetry.fields}->>'j1939Rpm', ${telemetry.fields}->>'obdRpm')::float < ${REPORT_RULES.idleRpm}
              else coalesce(${telemetry.speedKph}, 0) < ${REPORT_RULES.idleSpeedKph} end)`.mapWith(Number),
          })
          .from(telemetry)
          .where(and(inArray(telemetry.machineId, ids), gte(telemetry.receivedAt, from), lt(telemetry.receivedAt, to)))
          .groupBy(telemetry.machineId, sql`2`),
    none
      ? []
      : db
          .select({ checkin: checkins, operatorName: operators.name })
          .from(checkins)
          .innerJoin(operators, eq(operators.id, checkins.operatorId))
          .where(and(inArray(checkins.machineId, ids), gte(checkins.startedAt, new Date(range.from - 86_400_000)), lt(checkins.startedAt, to))),
    none
      ? []
      : db
          .select({ machineId: alerts.machineId, count: sql<number>`count(*)`.mapWith(Number) })
          .from(alerts)
          .where(and(inArray(alerts.machineId, ids), eq(alerts.type, "unauthorized-use"), gte(alerts.createdAt, from), lt(alerts.createdAt, to)))
          .groupBy(alerts.machineId),
    none
      ? []
      : db
          .select({ visit: worksiteVisits, site: worksites })
          .from(worksiteVisits)
          .innerJoin(worksites, eq(worksites.id, worksiteVisits.worksiteId))
          .where(
            and(
              inArray(worksiteVisits.machineId, ids),
              lt(worksiteVisits.enteredAt, to),
              or(isNull(worksiteVisits.leftAt), gte(worksiteVisits.leftAt, from)),
            ),
          ),
    // Engine computer (J1939) meters: hours and fuel used in the period = last reading − first reading.
    none
      ? []
      : db
          .select({
            machineId: telemetry.machineId,
            hours: sql<number | null>`max((${telemetry.fields}->>'j1939EngineHours')::float) - min((${telemetry.fields}->>'j1939EngineHours')::float)`,
            fuel: sql<number | null>`max((${telemetry.fields}->>'j1939TotalFuelL')::float) - min((${telemetry.fields}->>'j1939TotalFuelL')::float)`,
          })
          .from(telemetry)
          .where(
            and(
              inArray(telemetry.machineId, ids),
              gte(telemetry.receivedAt, from),
              lt(telemetry.receivedAt, to),
              sql`(${telemetry.fields} ? 'j1939EngineHours' or ${telemetry.fields} ? 'j1939TotalFuelL')`,
            ),
          )
          .groupBy(telemetry.machineId),
  ]);

  const plannedPerMachine = plannedHours(range, org?.plannedHoursPerDay ?? 8, org?.workingDays ?? [1, 2, 3, 4, 5]);
  const spanOf = (s: SessionSpan): [number, number] => [Math.max(s.startedAt.getTime(), range.from), Math.min(effectiveEnd(s, now), range.to)];
  const sessionsBy = Map.groupBy(sessions, (s) => s.machineId);
  const idleBy = Map.groupBy(idleRows, (r) => r.machineId!);
  const checkinsBy = Map.groupBy(
    checkinRows.filter((c) => c.checkin.startedAt.getTime() >= range.from),
    (c) => c.checkin.machineId,
  );
  const unauthorizedBy = new Map(unauthorized.map((u) => [u.machineId, u.count]));
  const ecuBy = new Map(ecuRows.map((r) => [r.machineId, { hours: r.hours === null ? null : Number(r.hours), fuel: r.fuel === null ? null : Number(r.fuel) }]));
  const visitsBy = Map.groupBy(visits, (v) => v.visit.machineId);
  /** Which operator each engine session belongs to (the latest check-in linked to it). */
  const sessionOperator = new Map<number, { id: number; name: string }>();
  for (const c of [...checkinRows].sort((a, b) => a.checkin.startedAt.getTime() - b.checkin.startedAt.getTime())) {
    if (c.checkin.engineSessionId) sessionOperator.set(c.checkin.engineSessionId, { id: c.checkin.operatorId, name: c.operatorName });
  }

  const operatorStats = new Map<number, { name: string; ms: number; checkins: number; machines: Set<number>; days: Set<string>; defects: number }>();
  const op = (id: number, name: string) => {
    let entry = operatorStats.get(id);
    if (!entry) operatorStats.set(id, (entry = { name, ms: 0, checkins: 0, machines: new Set(), days: new Set(), defects: 0 }));
    return entry;
  };

  const machineReports: MachineReport[] = fleet.map(({ machine, divisionName }) => {
    const byDay = new Map<string, number>();
    let coveredMs = 0;
    let lastUsed: number | null = null;
    const spans: [number, number][] = [];
    for (const s of sessionsBy.get(machine.id) ?? []) {
      const [start, end] = spanOf(s);
      if (end <= start) continue;
      spans.push([start, end]);
      lastUsed = Math.max(lastUsed ?? 0, end);
      for (const [day, ms] of splitByDay(start, end, range, tz)) byDay.set(day, (byDay.get(day) ?? 0) + ms);
      const who = sessionOperator.get(s.id);
      if (who) {
        coveredMs += end - start;
        const entry = op(who.id, who.name);
        entry.ms += end - start;
        entry.machines.add(machine.id);
        for (const day of splitByDay(start, end, range, tz).keys()) entry.days.add(day);
      }
    }
    const idleFraction = new Map((idleBy.get(machine.id) ?? []).map((r) => [r.day, r.on > 0 ? r.idle / r.on : 0]));
    const hoursByDay: Record<string, number> = {};
    const idleByDay: Record<string, number> = {};
    let idleMs = 0;
    for (const [day, ms] of byDay) {
      hoursByDay[day] = hoursOf(ms);
      idleByDay[day] = hoursOf(ms * (idleFraction.get(day) ?? 0));
      idleMs += ms * (idleFraction.get(day) ?? 0);
    }
    const machineCheckins = checkinsBy.get(machine.id) ?? [];
    const checkinDays = new Set(machineCheckins.map((c) => localDateKey(c.checkin.startedAt.getTime(), tz)));
    for (const c of machineCheckins) {
      const entry = op(c.checkin.operatorId, c.operatorName);
      entry.checkins++;
      entry.machines.add(machine.id);
      entry.days.add(localDateKey(c.checkin.startedAt.getTime(), tz));
      if (!c.checkin.checklistOk) entry.defects++;
    }
    // Days used: at least a minute of engine time.
    const usedDays = [...byDay].filter(([, ms]) => ms >= 60_000).map(([d]) => d).sort();
    const siteTime = new Map<string, number>();
    for (const v of visitsBy.get(machine.id) ?? []) {
      const ms = Math.min(v.visit.leftAt?.getTime() ?? now, range.to) - Math.max(v.visit.enteredAt.getTime(), range.from);
      if (ms > 0) siteTime.set(v.site.name, (siteTime.get(v.site.name) ?? 0) + ms);
    }
    const hours = hoursOf([...byDay.values()].reduce((a, b) => a + b, 0));
    return {
      id: machine.id,
      name: machine.name,
      unitNumber: machine.unitNumber,
      machineType: machine.machineType,
      divisionName,
      hours,
      idleHours: hoursOf(idleMs),
      coveredHours: hoursOf(coveredMs),
      hoursByDay,
      idleByDay,
      daysUsed: usedDays.length,
      daysWithCheckin: usedDays.filter((d) => checkinDays.has(d)).length,
      missedDays: usedDays.filter((d) => !checkinDays.has(d)),
      utilization: plannedPerMachine > 0 ? hours / plannedPerMachine : null,
      lastUsed: lastUsed ? new Date(lastUsed) : null,
      checkins: machineCheckins.length,
      checkinsWithDefects: machineCheckins.filter((c) => !c.checkin.checklistOk).length,
      startsWithoutCheckin: unauthorizedBy.get(machine.id) ?? 0,
      topWorksite: [...siteTime].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      meterHours: ecuBy.get(machine.id)?.hours ?? null,
      fuelL: ecuBy.get(machine.id)?.fuel ?? null,
    };
  });

  // Worksites: visits overlapping the range, time on site, and engine hours while on site.
  const sitesById = new Map<number, { site: (typeof visits)[number]["site"]; visits: number; machines: Set<number>; ms: number; engineMs: number }>();
  for (const v of visits) {
    const start = Math.max(v.visit.enteredAt.getTime(), range.from);
    const end = Math.min(v.visit.leftAt?.getTime() ?? now, range.to);
    if (end <= start) continue;
    let entry = sitesById.get(v.site.id);
    if (!entry) sitesById.set(v.site.id, (entry = { site: v.site, visits: 0, machines: new Set(), ms: 0, engineMs: 0 }));
    entry.visits++;
    entry.machines.add(v.visit.machineId);
    entry.ms += end - start;
    entry.engineMs += overlapMs([[start, end]], (sessionsBy.get(v.visit.machineId) ?? []).map(spanOf));
  }
  const worksiteReports: WorksiteReport[] = [...sitesById.values()]
    .map((e) => ({
      id: e.site.id,
      name: e.site.name,
      type: e.site.type,
      visits: e.visits,
      machines: e.machines.size,
      timeOnSiteHours: hoursOf(e.ms),
      engineHours: hoursOf(e.engineMs),
      avgVisitHours: e.visits ? hoursOf(e.ms) / e.visits : null,
    }))
    .sort((a, b) => b.engineHours - a.engineHours || b.timeOnSiteHours - a.timeOnSiteHours);

  const operatorReports: OperatorReport[] = [...operatorStats]
    .map(([id, e]) => ({ id, name: e.name, hours: hoursOf(e.ms), checkins: e.checkins, machines: e.machines.size, days: e.days.size, defects: e.defects }))
    .sort((a, b) => b.hours - a.hours || b.checkins - a.checkins);

  const sum = (f: (m: MachineReport) => number) => machineReports.reduce((a, m) => a + f(m), 0);
  const totalHours = sum((m) => m.hours);
  return {
    range,
    plannedHoursPerMachine: plannedPerMachine,
    plannedHoursPerDay: org?.plannedHoursPerDay ?? 8,
    workingDays: org?.workingDays ?? [1, 2, 3, 4, 5],
    machines: machineReports,
    operators: operatorReports,
    worksites: worksiteReports,
    totals: {
      hours: totalHours,
      idleHours: sum((m) => m.idleHours),
      coveredHours: sum((m) => m.coveredHours),
      machines: machineReports.length,
      activeMachines: machineReports.filter((m) => m.daysUsed > 0).length,
      activeOperators: operatorReports.filter((o) => o.hours > 0 || o.checkins > 0).length,
      utilization: plannedPerMachine > 0 && machineReports.length ? totalHours / (plannedPerMachine * machineReports.length) : null,
      daysOperated: sum((m) => m.daysUsed),
      daysWithCheckin: sum((m) => m.daysWithCheckin),
      checkins: sum((m) => m.checkins),
      checkinsWithDefects: sum((m) => m.checkinsWithDefects),
      startsWithoutCheckin: sum((m) => m.startsWithoutCheckin),
      fuelMachines: machineReports.filter((m) => m.fuelL !== null).length,
      fuelL: sum((m) => m.fuelL ?? 0),
    },
  };
}

// ---------- CSV ----------

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  // Quote anything with separators, and neutralise spreadsheet formulas.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

const h2 = (n: number) => n.toFixed(2);
const pct = (n: number | null) => (n === null ? "" : (n * 100).toFixed(1));

export const REPORT_CSV = {
  machines: (r: Report) => [
    ["Unit", "Machine", "Type", "Division", "Engine hours", "Idle hours (est.)", "Idle %", "Days used", "Utilization %", "Last used", "Most time at worksite", "Hour meter hours (engine computer)", "Fuel used (L)", "Average fuel (L/h)"],
    ...r.machines.map((m) => [
      m.unitNumber,
      m.name,
      m.machineType,
      m.divisionName,
      h2(m.hours),
      h2(m.idleHours),
      m.hours ? pct(m.idleHours / m.hours) : "",
      m.daysUsed,
      pct(m.utilization),
      m.lastUsed,
      m.topWorksite,
      m.meterHours === null ? "" : h2(m.meterHours),
      m.fuelL === null ? "" : h2(m.fuelL),
      m.fuelL !== null && m.hours > 0 ? h2(m.fuelL / m.hours) : "",
    ]),
  ],
  operators: (r: Report) => [
    ["Operator", "Engine hours", "Check-ins", "Machines", "Days", "Check-ins with defects"],
    ...r.operators.map((o) => [o.name, h2(o.hours), o.checkins, o.machines, o.days, o.defects]),
  ],
  compliance: (r: Report) => [
    ["Unit", "Machine", "Days operated", "Days with a check-in", "Compliance %", "Hours with operator", "Engine hours", "Starts without check-in", "Check-ins", "With defects", "Days without a check-in"],
    ...r.machines.map((m) => [
      m.unitNumber,
      m.name,
      m.daysUsed,
      m.daysWithCheckin,
      m.daysUsed ? pct(m.daysWithCheckin / m.daysUsed) : "",
      h2(m.coveredHours),
      h2(m.hours),
      m.startsWithoutCheckin,
      m.checkins,
      m.checkinsWithDefects,
      m.missedDays.join(" "),
    ]),
  ],
  worksites: (r: Report) => [
    ["Worksite", "Type", "Visits", "Machines", "Time on site (h)", "Engine hours on site", "Average visit (h)"],
    ...r.worksites.map((w) => [w.name, w.type, w.visits, w.machines, h2(w.timeOnSiteHours), h2(w.engineHours), w.avgVisitHours === null ? "" : h2(w.avgVisitHours)]),
  ],
};
export type ReportCsv = keyof typeof REPORT_CSV;
