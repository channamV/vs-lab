import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { checkinPhotos, checkins, machines, operators } from "@/lib/db/schema";
import { machineScope, type Scope } from "@/lib/divisions";
import { locationLabel } from "@/lib/checkin-flags";
import { machineLabel } from "@/lib/format";
import { reportRange, type ReportRange } from "@/lib/reports";
import { localDateKey } from "@/lib/telemetry/engine";

/**
 * Pre-start checklist results (Craig, 2026-10-26; docs/checklist-results.md; modelled on Veristart production's
 * Prestart Checklist list, detail and bulk export): every check-in's checklist, filtered by date, machine, division,
 * operator and result; one checklist's answers; a CSV with one row per answer; a printable bulk report.
 * Always scoped to the organization and the user's divisions.
 */

export const RESULT_RULES = {
  pageSize: 50,
  /** Results can look back further than reports (audits). */
  maxDays: 366,
  /** Most check-ins in one CSV / printable report. */
  maxExport: 5000,
  maxPrint: 200,
};

export const RESULT_FILTERS = {
  all: "All results",
  defects: "With defects",
  locked_out: "Locked out",
  ok: "All OK",
} as const;
export type ResultFilter = keyof typeof RESULT_FILTERS;

export type ResultFilters = {
  range: ReportRange;
  machineId: number | null;
  operatorId: number | null;
  divisionId: number | null;
  result: ResultFilter;
  /** Show check-ins that relied on an earlier checklist that day ("Done earlier today"). */
  includeCovered: boolean;
  page: number;
};

const id = (v: string | undefined) => (v && /^\d{1,15}$/.test(v) ? Number(v) : null);

/** Filters from the page's query string (pure). */
export function parseResultFilters(params: Record<string, string | undefined>, now: number, tz: string): ResultFilters {
  return {
    range: reportRange({ range: params.range ?? "30d", from: params.from, to: params.to }, now, tz, RESULT_RULES.maxDays),
    machineId: id(params.machine),
    operatorId: id(params.operator),
    divisionId: id(params.division),
    result: params.result && params.result in RESULT_FILTERS ? (params.result as ResultFilter) : "all",
    includeCovered: params.covered === "1",
    page: Math.max(1, Math.min(10_000, id(params.page) ?? 1)),
  };
}

/** The filters as a query string (for links, CSV and print), without the page unless asked. */
export function filterQuery(f: ResultFilters, extra: Record<string, string | number> = {}) {
  const q = new URLSearchParams();
  q.set("range", f.range.preset);
  if (f.range.preset === "custom") {
    q.set("from", f.range.fromDate);
    q.set("to", f.range.toDate);
  }
  if (f.machineId) q.set("machine", String(f.machineId));
  if (f.operatorId) q.set("operator", String(f.operatorId));
  if (f.divisionId) q.set("division", String(f.divisionId));
  if (f.result !== "all") q.set("result", f.result);
  if (f.includeCovered) q.set("covered", "1");
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return q.toString();
}

export type ResultKind = "ok" | "defects" | "locked_out" | "covered";

/** A check-in's checklist outcome (pure). */
export function resultOf(c: { checklistOk: boolean; lockoutRequested: boolean; checklistFromCheckinId: number | null }): ResultKind {
  if (c.checklistFromCheckinId !== null) return "covered";
  if (c.lockoutRequested) return "locked_out";
  return c.checklistOk ? "ok" : "defects";
}

function where(organizationId: number, scope: Scope, f: ResultFilters): SQL {
  const parts: (SQL | undefined)[] = [
    eq(checkins.organizationId, organizationId),
    eq(machines.organizationId, organizationId),
    machineScope(scope),
    gte(checkins.startedAt, new Date(f.range.from)),
    lt(checkins.startedAt, new Date(f.range.to)),
    f.machineId ? eq(checkins.machineId, f.machineId) : undefined,
    f.operatorId ? eq(checkins.operatorId, f.operatorId) : undefined,
    f.divisionId ? eq(machines.divisionId, f.divisionId) : undefined,
    f.includeCovered ? undefined : isNull(checkins.checklistFromCheckinId),
    // Beacon check-ins (relay machines) have no checklist and aren't covered by one: not a result.
    sql`(jsonb_array_length(${checkins.answers}) > 0 or ${checkins.checklistFromCheckinId} is not null)`,
  ];
  if (f.result === "defects") parts.push(eq(checkins.checklistOk, false));
  if (f.result === "locked_out") parts.push(eq(checkins.lockoutRequested, true));
  if (f.result === "ok") parts.push(eq(checkins.checklistOk, true), isNull(checkins.checklistFromCheckinId));
  return and(...parts)!;
}

const columns = {
  id: checkins.id,
  startedAt: checkins.startedAt,
  machineId: checkins.machineId,
  machineName: machines.name,
  unitNumber: machines.unitNumber,
  operatorId: checkins.operatorId,
  operatorName: operators.name,
  templateName: checkins.templateName,
  checklistOk: checkins.checklistOk,
  lockoutRequested: checkins.lockoutRequested,
  checklistFromCheckinId: checkins.checklistFromCheckinId,
  answers: checkins.answers,
  notes: checkins.notes,
  confirmationText: checkins.confirmationText,
  authorized: checkins.authorized,
  locationCheck: checkins.locationCheck,
  distanceM: checkins.distanceM,
};

async function photosFor(db: Db, ids: number[]) {
  if (!ids.length) return [];
  return db
    .select({ id: checkinPhotos.id, checkinId: checkinPhotos.checkinId, questionId: checkinPhotos.questionId })
    .from(checkinPhotos)
    .where(inArray(checkinPhotos.checkinId, ids))
    .orderBy(asc(checkinPhotos.id));
}

/** One page of results, newest first, with the total and each check-in's photos. */
export async function queryChecklistResults(db: Db, organizationId: number, scope: Scope, f: ResultFilters, opts: { limit?: number; offset?: number } = {}) {
  const limit = opts.limit ?? RESULT_RULES.pageSize;
  const offset = opts.offset ?? (f.page - 1) * RESULT_RULES.pageSize;
  const w = where(organizationId, scope, f);
  const [rows, [{ n }]] = await Promise.all([
    db
      .select(columns)
      .from(checkins)
      .innerJoin(machines, eq(machines.id, checkins.machineId))
      .innerJoin(operators, eq(operators.id, checkins.operatorId))
      .where(w)
      .orderBy(desc(checkins.startedAt), desc(checkins.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(checkins).innerJoin(machines, eq(machines.id, checkins.machineId)).where(w),
  ]);
  const photos = await photosFor(db, rows.map((r) => r.id));
  return {
    total: Number(n),
    rows: rows.map((r) => ({ ...r, result: resultOf(r), photos: photos.filter((p) => p.checkinId === r.id) })),
  };
}

export type ChecklistResultRow = Awaited<ReturnType<typeof queryChecklistResults>>["rows"][number];

/** One check-in's checklist (in the organization and the user's divisions), with the one that covered it if any. */
export async function checklistResultById(db: Db, organizationId: number, scope: Scope, checkinId: number) {
  const [row] = await db
    .select(columns)
    .from(checkins)
    .innerJoin(machines, eq(machines.id, checkins.machineId))
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .where(and(eq(checkins.id, checkinId), eq(checkins.organizationId, organizationId), eq(machines.organizationId, organizationId), machineScope(scope)));
  if (!row) return null;
  const [photos, [covering]] = await Promise.all([
    photosFor(db, [row.id]),
    row.checklistFromCheckinId
      ? db
          .select({ id: checkins.id, startedAt: checkins.startedAt, operatorName: operators.name })
          .from(checkins)
          .innerJoin(operators, eq(operators.id, checkins.operatorId))
          .where(and(eq(checkins.id, row.checklistFromCheckinId), eq(checkins.organizationId, organizationId)))
      : [],
  ]);
  return { ...row, result: resultOf(row), photos, covering: covering ?? null };
}

export const RESULT_LABELS: Record<ResultKind, string> = {
  ok: "All OK",
  defects: "Defects",
  locked_out: "Locked out",
  covered: "Done earlier today",
};

/** The CSV: one row per answer (pure), so it can be filtered and pivoted in Excel. */
export function resultsCsvRows(rows: ChecklistResultRow[], tz: string, coveringTimes: Map<number, Date> = new Map()) {
  const time = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const out: (string | number)[][] = [
    ["Date", "Time", "Unit", "Machine", "Operator", "Checklist", "Result", "Section", "Question", "Answer", "Defect", "Note", "Photos", "At machine", "Check-in ID"],
  ];
  for (const r of rows) {
    const base = [localDateKey(r.startedAt.getTime(), tz), time.format(r.startedAt), r.unitNumber ?? "", r.machineName, r.operatorName, r.templateName ?? ""];
    const at = locationLabel(r).text;
    if (r.result === "covered") {
      const when = coveringTimes.get(r.checklistFromCheckinId!);
      out.push([...base, RESULT_LABELS.covered, "", "", when ? `Covered by the checklist at ${time.format(when)}` : "Covered by an earlier checklist", "", "", 0, at, r.id]);
      continue;
    }
    for (const a of r.answers) {
      const defect = a.severity === "minor" ? "Minor" : a.severity === "major" ? "Major" : "";
      out.push([...base, RESULT_LABELS[r.result], a.section ?? "", a.question, a.answer ?? (a.ok ? "OK" : "Not OK"), defect, a.note ?? "", r.photos.filter((p) => p.questionId === a.id).length, at, r.id]);
    }
    if (r.notes) out.push([...base, RESULT_LABELS[r.result], "", "General notes", "", "", r.notes, 0, at, r.id]);
  }
  return out;
}

/** "Unit 14 · Loader" for a result row. */
export const resultMachine = (r: { unitNumber: string | null; machineName: string }) => machineLabel({ unitNumber: r.unitNumber, name: r.machineName });

