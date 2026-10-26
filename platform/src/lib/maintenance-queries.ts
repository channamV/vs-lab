import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  checkinPhotos,
  checkins,
  machines,
  maintenanceActivity,
  maintenanceAttachments,
  maintenanceIssues,
  maintenanceReports,
  maintenanceSchedules,
  meterReadings,
  operators,
  users,
  worksites,
  worksiteVisits,
} from "@/lib/db/schema";
import { machineScope, type Scope } from "@/lib/divisions";
import { machineLabel } from "@/lib/format";
import { currentReadings, type MachineReadings } from "@/lib/meters";
import { byUrgency, describeDuePart, dueState, PRIORITIES, priorityRank, type Priority, SOURCES, STATUSES, topPriority, type DueState } from "@/lib/maintenance-types";
import { reportRange, type ReportRange } from "@/lib/reports";
import { localDateKey } from "@/lib/telemetry/engine";

/**
 * Reads for the maintenance pages (src/lib/data.ts adds the session; docs/maintenance.md). Always scoped to the
 * organization and the user's divisions through the machine.
 */

const issueColumns = {
  id: maintenanceIssues.id,
  number: maintenanceIssues.number,
  machineId: maintenanceIssues.machineId,
  source: maintenanceIssues.source,
  priority: maintenanceIssues.priority,
  status: maintenanceIssues.status,
  title: maintenanceIssues.title,
  reportCount: maintenanceIssues.reportCount,
  firstReportedAt: maintenanceIssues.firstReportedAt,
  lastReportedAt: maintenanceIssues.lastReportedAt,
  resolvedAt: maintenanceIssues.resolvedAt,
  machineName: machines.name,
  unitNumber: machines.unitNumber,
};

/** Checklist photos of each item (the reported question, from every checklist that reported it), oldest first. */
async function evidencePhotos(db: Db, issueIds: number[]) {
  if (!issueIds.length) return [];
  return db
    .select({ issueId: maintenanceReports.issueId, id: checkinPhotos.id, checkinId: checkinPhotos.checkinId, takenAt: checkinPhotos.takenAt })
    .from(maintenanceReports)
    .innerJoin(maintenanceIssues, eq(maintenanceIssues.id, maintenanceReports.issueId))
    .innerJoin(checkinPhotos, and(eq(checkinPhotos.checkinId, maintenanceReports.checkinId), eq(checkinPhotos.questionId, maintenanceIssues.questionId)))
    .where(inArray(maintenanceReports.issueId, issueIds))
    .orderBy(asc(checkinPhotos.takenAt), asc(checkinPhotos.id));
}

/** Image attachments of each item (for thumbnails). */
async function imageAttachments(db: Db, issueIds: number[]) {
  if (!issueIds.length) return [];
  return db
    .select({ issueId: maintenanceAttachments.issueId, id: maintenanceAttachments.id })
    .from(maintenanceAttachments)
    .where(and(inArray(maintenanceAttachments.issueId, issueIds), sql`${maintenanceAttachments.contentType} like 'image/%'`))
    .orderBy(asc(maintenanceAttachments.id));
}

/** Items with the machine's name and a thumbnail (first checklist photo, else first image attached). */
async function withThumbs<T extends { id: number }>(db: Db, rows: T[]) {
  const ids = rows.map((r) => r.id);
  const [photos, images] = await Promise.all([evidencePhotos(db, ids), imageAttachments(db, ids)]);
  return rows.map((r) => {
    const p = photos.filter((x) => x.issueId === r.id);
    const a = images.filter((x) => x.issueId === r.id);
    return {
      ...r,
      thumb: p[0] ? `/photos/${p[0].id}` : a[0] ? `/maintenance/files/${a[0].id}` : null,
      photoCount: p.length + a.length,
    };
  });
}



/** Open items (and those resolved in the last `resolvedDays`) on the machines the user can see, most urgent first. */
export async function issueBoard(db: Db, scope: Scope, opts: { machineId?: number | null; now: Date; resolvedDays?: number }) {
  const since = new Date(opts.now.getTime() - (opts.resolvedDays ?? 7) * 86_400_000);
  const rows = await db
    .select(issueColumns)
    .from(maintenanceIssues)
    .innerJoin(machines, eq(machines.id, maintenanceIssues.machineId))
    .where(
      and(
        eq(maintenanceIssues.organizationId, scope.organizationId),
        machineScope(scope),
        or(isNull(maintenanceIssues.resolvedAt), gte(maintenanceIssues.resolvedAt, since)),
        opts.machineId ? eq(maintenanceIssues.machineId, opts.machineId) : undefined,
      ),
    )
    .limit(1000);
  return withThumbs(db, rows.sort(byUrgency));
}

export type IssueRow = Awaited<ReturnType<typeof issueBoard>>[number];

export type ServiceSummary = { scheduleId: number; description: string; state: DueState["state"]; text: string };

/** Each schedule's state on the machines given (pure apart from the readings passed in). */
function scheduleStates(
  schedules: (typeof maintenanceSchedules.$inferSelect)[],
  readings: Map<number, MachineReadings>,
  today: string,
): Map<number, ServiceSummary[]> {
  const out = new Map<number, ServiceSummary[]>();
  for (const s of schedules) {
    const r = readings.get(s.machineId);
    const state = dueState(s, today, { hours: r?.hours?.value ?? null, km: r?.km?.value ?? null });
    const soonest = [...state.parts].sort((a, b) => (a.state === "due" ? -1 : 0) - (b.state === "due" ? -1 : 0))[0];
    const list = out.get(s.machineId) ?? [];
    list.push({ scheduleId: s.id, description: s.description, state: state.state, text: soonest ? describeDuePart(soonest) : "needs a meter reading" });
    out.set(s.machineId, list);
  }
  const rank = { due: 0, soon: 1, unknown: 2, ok: 3 } as const;
  for (const list of out.values()) list.sort((a, b) => rank[a.state] - rank[b.state]);
  return out;
}

/**
 * "By machine": every machine with open items or a service due soon, worst first, with its items (most urgent
 * first), its next service, and how many items were resolved today. Plus the headline numbers.
 */
export async function maintenanceByMachine(db: Db, scope: Scope, opts: { now: Date; timeZone: string; worksiteId?: number | null }) {
  const today = localDateKey(opts.now.getTime(), opts.timeZone);
  const [open, schedules, resolvedRecent] = await Promise.all([
    issueBoard(db, scope, { now: opts.now, resolvedDays: 0 }),
    db
      .select({ schedule: maintenanceSchedules })
      .from(maintenanceSchedules)
      .innerJoin(machines, eq(machines.id, maintenanceSchedules.machineId))
      .where(and(eq(maintenanceSchedules.organizationId, scope.organizationId), machineScope(scope), eq(maintenanceSchedules.active, true))),
    db
      .select({ machineId: maintenanceIssues.machineId, resolvedAt: maintenanceIssues.resolvedAt })
      .from(maintenanceIssues)
      .innerJoin(machines, eq(machines.id, maintenanceIssues.machineId))
      .where(and(eq(maintenanceIssues.organizationId, scope.organizationId), machineScope(scope), gte(maintenanceIssues.resolvedAt, new Date(opts.now.getTime() - 7 * 86_400_000)))),
  ]);
  const openIssues = open.filter((i) => i.resolvedAt === null);
  const readings = await currentReadings(db, [...new Set(schedules.map((s) => s.schedule.machineId))], opts.now);
  const services = scheduleStates(
    schedules.map((s) => s.schedule),
    readings,
    today,
  );
  // Worksite filter: machines in that site now (open visit).
  let inSite: Set<number> | null = null;
  if (opts.worksiteId) {
    const rows = await db
      .select({ machineId: worksiteVisits.machineId })
      .from(worksiteVisits)
      .where(and(eq(worksiteVisits.worksiteId, opts.worksiteId), eq(worksiteVisits.organizationId, scope.organizationId), isNull(worksiteVisits.leftAt)));
    inSite = new Set(rows.map((r) => r.machineId));
  }
  const machineIds = new Set<number>([...openIssues.map((i) => i.machineId), ...[...services].filter(([, l]) => l.some((s) => s.state === "due" || s.state === "soon")).map(([id]) => id)]);
  const names = machineIds.size
    ? await db
        .select({ id: machines.id, name: machines.name, unitNumber: machines.unitNumber, lockedOutAt: machines.lockedOutAt })
        .from(machines)
        .where(inArray(machines.id, [...machineIds]))
    : [];
  const cards = names
    .filter((m) => !inSite || inSite.has(m.id))
    .map((m) => {
      const issues = openIssues.filter((i) => i.machineId === m.id);
      return {
        id: m.id,
        label: machineLabel(m),
        lockedOut: m.lockedOutAt !== null,
        issues,
        worst: topPriority(issues.map((i) => i.priority)),
        services: (services.get(m.id) ?? []).filter((s) => s.state === "due" || s.state === "soon"),
        resolvedToday: resolvedRecent.filter((r) => r.machineId === m.id && r.resolvedAt && localDateKey(r.resolvedAt.getTime(), opts.timeZone) === today).length,
      };
    })
    .sort(
      (a, b) =>
        priorityRank(b.worst ?? "") - priorityRank(a.worst ?? "") ||
        b.issues.length - a.issues.length ||
        a.label.localeCompare(b.label),
    );
  const ages = openIssues.map((i) => (opts.now.getTime() - i.firstReportedAt.getTime()) / 86_400_000);
  const oldest = [...openIssues].sort((a, b) => a.firstReportedAt.getTime() - b.firstReportedAt.getTime())[0];
  return {
    cards,
    kpis: {
      open: openIssues.length,
      machines: new Set(openIssues.map((i) => i.machineId)).size,
      avgAgeDays: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null,
      oldest: oldest ? { number: oldest.number, id: oldest.id, days: Math.floor((opts.now.getTime() - oldest.firstReportedAt.getTime()) / 86_400_000) } : null,
      resolved7d: resolvedRecent.length,
      byPriority: Object.entries(
        openIssues.reduce<Record<string, number>>((acc, i) => ((acc[i.priority] = (acc[i.priority] ?? 0) + 1), acc), {}),
      ).sort(([a], [b]) => priorityRank(b) - priorityRank(a)),
    },
  };
}

/** One item with everything the issue card shows, or null if it isn't the user's to see. */
export async function issueDetail(db: Db, scope: Scope, issueId: number, now: Date) {
  const [row] = await db
    .select({ issue: maintenanceIssues, machine: machines, worksiteName: worksites.name, worksiteType: worksites.type })
    .from(maintenanceIssues)
    .innerJoin(machines, eq(machines.id, maintenanceIssues.machineId))
    .leftJoin(worksites, eq(worksites.id, maintenanceIssues.worksiteId))
    .where(and(eq(maintenanceIssues.id, issueId), eq(maintenanceIssues.organizationId, scope.organizationId), machineScope(scope)));
  if (!row) return null;
  const { issue } = row;
  const [reports, photos, attachments, activity, schedule, readings, vendors, otherOpen] = await Promise.all([
    db
      .select({
        id: maintenanceReports.id,
        checkinId: maintenanceReports.checkinId,
        reportedAt: maintenanceReports.reportedAt,
        answerLabel: maintenanceReports.answerLabel,
        severity: maintenanceReports.severity,
        note: maintenanceReports.note,
        operatorName: operators.name,
      })
      .from(maintenanceReports)
      .leftJoin(checkins, eq(checkins.id, maintenanceReports.checkinId))
      .leftJoin(operators, eq(operators.id, checkins.operatorId))
      .where(eq(maintenanceReports.issueId, issue.id))
      .orderBy(asc(maintenanceReports.reportedAt), asc(maintenanceReports.id)),
    evidencePhotos(db, [issue.id]),
    db.select().from(maintenanceAttachments).where(eq(maintenanceAttachments.issueId, issue.id)).orderBy(asc(maintenanceAttachments.uploadedAt)),
    db
      .select({ id: maintenanceActivity.id, at: maintenanceActivity.at, kind: maintenanceActivity.kind, detail: maintenanceActivity.detail, email: users.email })
      .from(maintenanceActivity)
      .leftJoin(users, eq(users.id, maintenanceActivity.userId))
      .where(eq(maintenanceActivity.issueId, issue.id))
      .orderBy(desc(maintenanceActivity.at), desc(maintenanceActivity.id)),
    issue.scheduleId ? db.select().from(maintenanceSchedules).where(eq(maintenanceSchedules.id, issue.scheduleId)).then((r) => r[0] ?? null) : null,
    currentReadings(db, [issue.machineId], now).then((m) => m.get(issue.machineId) ?? { hours: null, km: null }),
    db
      .selectDistinct({ name: maintenanceIssues.vendorName })
      .from(maintenanceIssues)
      .where(and(eq(maintenanceIssues.organizationId, scope.organizationId), isNotNull(maintenanceIssues.vendorName)))
      .orderBy(asc(maintenanceIssues.vendorName))
      .limit(100),
    db
      .select({ id: maintenanceIssues.id, number: maintenanceIssues.number, title: maintenanceIssues.title, priority: maintenanceIssues.priority })
      .from(maintenanceIssues)
      .where(and(eq(maintenanceIssues.machineId, issue.machineId), isNull(maintenanceIssues.resolvedAt), sql`${maintenanceIssues.id} <> ${issue.id}`))
      .orderBy(asc(maintenanceIssues.firstReportedAt)),
  ]);
  return {
    issue,
    machine: { id: row.machine.id, label: machineLabel(row.machine), lat: row.machine.lastLat, lng: row.machine.lastLng, lastFixAt: row.machine.lastFixAt, lockedOutAt: row.machine.lockedOutAt, onRoad: row.machine.onRoad },
    worksite: row.worksiteName ? { name: row.worksiteName, type: row.worksiteType } : null,
    reports: reports.map((r) => ({ ...r, photoIds: photos.filter((p) => p.checkinId === r.checkinId).map((p) => p.id) })),
    attachments,
    activity,
    schedule,
    readings,
    vendors: vendors.map((v) => v.name!).filter(Boolean),
    otherOpen: otherOpen.sort(byUrgency as never),
  };
}

/** Service schedules on the machines the user can see, with where each stands. */
export async function scheduleList(db: Db, scope: Scope, opts: { now: Date; timeZone: string }) {
  const rows = await db
    .select({ schedule: maintenanceSchedules, name: machines.name, unitNumber: machines.unitNumber, openIssueId: maintenanceIssues.id, openIssueNumber: maintenanceIssues.number })
    .from(maintenanceSchedules)
    .innerJoin(machines, eq(machines.id, maintenanceSchedules.machineId))
    .leftJoin(maintenanceIssues, and(eq(maintenanceIssues.scheduleId, maintenanceSchedules.id), isNull(maintenanceIssues.resolvedAt)))
    .where(and(eq(maintenanceSchedules.organizationId, scope.organizationId), machineScope(scope)))
    .orderBy(asc(machines.name), asc(maintenanceSchedules.description));
  const readings = await currentReadings(db, [...new Set(rows.map((r) => r.schedule.machineId))], opts.now);
  const today = localDateKey(opts.now.getTime(), opts.timeZone);
  return rows.map((r) => {
    const reading = readings.get(r.schedule.machineId) ?? { hours: null, km: null };
    return {
      ...r.schedule,
      machineLabel: machineLabel({ name: r.name, unitNumber: r.unitNumber }),
      readings: reading,
      due: dueState(r.schedule, today, { hours: reading.hours?.value ?? null, km: reading.km?.value ?? null }),
      openIssue: r.openIssueId ? { id: r.openIssueId, number: r.openIssueNumber! } : null,
    };
  });
}

/** A machine's maintenance for its page: open items, schedules, current readings and the latest readings given. */
export async function machineMaintenance(db: Db, scope: Scope, machineId: number, opts: { now: Date; timeZone: string }) {
  const [open, schedules, history] = await Promise.all([
    issueBoard(db, scope, { machineId, now: opts.now, resolvedDays: 0 }),
    scheduleList(db, scope, opts).then((all) => all.filter((s) => s.machineId === machineId)),
    db
      .select({ id: meterReadings.id, kind: meterReadings.kind, value: meterReadings.value, source: meterReadings.source, recordedAt: meterReadings.recordedAt })
      .from(meterReadings)
      .where(eq(meterReadings.machineId, machineId))
      .orderBy(desc(meterReadings.recordedAt), desc(meterReadings.id))
      .limit(10),
  ]);
  const readings = (await currentReadings(db, [machineId], opts.now)).get(machineId) ?? { hours: null, km: null };
  return { open: open.filter((i) => i.resolvedAt === null), schedules, readings, history };
}

// ---------- History (all items, filtered) ----------

export const HISTORY_RULES = { pageSize: 50, maxDays: 731, maxExport: 5000 };

export type HistoryFilters = {
  range: ReportRange;
  machineId: number | null;
  status: "all" | "open" | "resolved";
  source: string | null;
  page: number;
};

const idParam = (v: string | undefined) => (v && /^\d{1,15}$/.test(v) ? Number(v) : null);

/** Filters from the History page's query string (pure). Dates are when the item was opened. */
export function parseHistoryFilters(params: Record<string, string | undefined>, now: number, tz: string): HistoryFilters {
  return {
    range: reportRange({ range: params.range ?? "90d", from: params.from, to: params.to }, now, tz, HISTORY_RULES.maxDays),
    machineId: idParam(params.machine),
    status: params.status === "open" || params.status === "resolved" ? params.status : "all",
    source: params.source && params.source in SOURCES ? params.source : null,
    page: Math.max(1, Math.min(10_000, idParam(params.page) ?? 1)),
  };
}

export function historyQuery(f: HistoryFilters, extra: Record<string, string | number> = {}) {
  const q = new URLSearchParams();
  q.set("range", f.range.preset);
  if (f.range.preset === "custom") {
    q.set("from", f.range.fromDate);
    q.set("to", f.range.toDate);
  }
  if (f.machineId) q.set("machine", String(f.machineId));
  if (f.status !== "all") q.set("status", f.status);
  if (f.source) q.set("source", f.source);
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return q.toString();
}

export async function issueHistory(db: Db, scope: Scope, f: HistoryFilters, opts: { limit?: number; offset?: number } = {}) {
  const parts: (SQL | undefined)[] = [
    eq(maintenanceIssues.organizationId, scope.organizationId),
    machineScope(scope),
    gte(maintenanceIssues.firstReportedAt, new Date(f.range.from)),
    lt(maintenanceIssues.firstReportedAt, new Date(f.range.to)),
    f.machineId ? eq(maintenanceIssues.machineId, f.machineId) : undefined,
    f.status === "open" ? isNull(maintenanceIssues.resolvedAt) : f.status === "resolved" ? isNotNull(maintenanceIssues.resolvedAt) : undefined,
    f.source ? eq(maintenanceIssues.source, f.source) : undefined,
  ];
  const where = and(...parts);
  const limit = opts.limit ?? HISTORY_RULES.pageSize;
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({
        ...issueColumns,
        complaint: maintenanceIssues.complaint,
        cause: maintenanceIssues.cause,
        correction: maintenanceIssues.correction,
        performedBy: maintenanceIssues.performedBy,
        vendorName: maintenanceIssues.vendorName,
        servicedHours: maintenanceIssues.servicedHours,
        servicedKm: maintenanceIssues.servicedKm,
        servicedOn: maintenanceIssues.servicedOn,
      })
      .from(maintenanceIssues)
      .innerJoin(machines, eq(machines.id, maintenanceIssues.machineId))
      .where(where)
      .orderBy(desc(maintenanceIssues.firstReportedAt), desc(maintenanceIssues.id))
      .limit(limit)
      .offset(opts.offset ?? (f.page - 1) * HISTORY_RULES.pageSize),
    db.select({ n: count() }).from(maintenanceIssues).innerJoin(machines, eq(machines.id, maintenanceIssues.machineId)).where(where),
  ]);
  return { total: Number(n), rows };
}

/** The History CSV: one row per item (pure). */
export function historyCsvRows(rows: Awaited<ReturnType<typeof issueHistory>>["rows"], tz: string) {
  const date = (d: Date | null) => (d ? localDateKey(d.getTime(), tz) : "");
  const out: (string | number)[][] = [
    ["Number", "Opened", "Resolved", "Unit", "Machine", "Source", "Priority", "Status", "Title", "Reports", "Complaint", "Cause", "Correction", "Done by", "Vendor", "Service date", "Hours at service", "Km at service"],
  ];
  for (const r of rows) {
    out.push([
      r.number,
      date(r.firstReportedAt),
      date(r.resolvedAt),
      r.unitNumber ?? "",
      r.machineName,
      SOURCES[r.source as keyof typeof SOURCES] ?? r.source,
      PRIORITIES[r.priority as Priority]?.label ?? r.priority,
      STATUSES[r.status as keyof typeof STATUSES]?.label ?? r.status,
      r.title,
      r.reportCount,
      r.complaint,
      r.cause ?? "",
      r.correction ?? "",
      r.performedBy === "vendor" ? "Vendor" : r.performedBy === "internal" ? "Our technician" : "",
      r.vendorName ?? "",
      r.servicedOn ?? "",
      r.servicedHours ?? "",
      r.servicedKm ?? "",
    ]);
  }
  return out;
}

