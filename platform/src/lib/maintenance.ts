import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, max, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  deviceAssignments,
  machines,
  maintenanceActivity,
  maintenanceAttachments,
  maintenanceIssues,
  maintenanceReports,
  maintenanceSchedules,
  worksiteVisits,
  type MaintenanceIssue,
} from "@/lib/db/schema";
import type { Defect } from "@/lib/checklists";
import { currentReadings, MeterError, recordReading } from "@/lib/meters";
import {
  describeDuePart,
  describeInterval,
  dueState,
  isPriority,
  isStatus,
  MAINTENANCE_RULES,
  missingForResolve,
  nextDueFrom,
  priorityRank,
  PRIORITIES,
  SECTIONS,
  STATUSES,
  type Interval,
  type Priority,
  type Section,
  type Status,
} from "@/lib/maintenance-types";
import { recordEvent } from "@/lib/notifications";
import { orgTimeZone } from "@/lib/org-time";
import { localDateKey } from "@/lib/telemetry/engine";

/**
 * Maintenance (docs/maintenance.md; Craig 2026-10-26, modelled on Veristart Insights' maintenance module). Work
 * items come from checklist defects, service schedules coming due, devices gone quiet, and staff. One open item per
 * machine + `dedupe_key`: a defect reported again on a later checklist is added to the open item (another report,
 * with that checklist's photos) instead of a new item. Items follow the three C's; resolving needs all three.
 * Everything takes the organization id; callers check roles and divisions.
 */

export class MaintenanceError extends Error {}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Tx;

const clean = (v: string | null | undefined, max = 4000) => (v ?? "").trim().slice(0, max) || null;

async function log(db: DbLike, issueId: number, userId: number | null, kind: string, detail: string, at: Date) {
  await db.insert(maintenanceActivity).values({ issueId, userId, kind, detail: detail.slice(0, 1000), at });
}

/** Where the machine is now (position and any worksite it's in), for a new item. */
async function machinePlace(db: DbLike, machineId: number) {
  const [m] = await db.select({ lat: machines.lastLat, lng: machines.lastLng }).from(machines).where(eq(machines.id, machineId));
  const [visit] = await db
    .select({ worksiteId: worksiteVisits.worksiteId })
    .from(worksiteVisits)
    .where(and(eq(worksiteVisits.machineId, machineId), isNull(worksiteVisits.leftAt)))
    .orderBy(desc(worksiteVisits.enteredAt))
    .limit(1);
  return { lat: m?.lat ?? null, lng: m?.lng ?? null, worksiteId: visit?.worksiteId ?? null };
}

type NewIssue = Omit<typeof maintenanceIssues.$inferInsert, "id" | "number">;

/** Adds an item with the organization's next number (#1001, #1002 …). */
async function insertIssue(db: DbLike, values: NewIssue, createdBy: { userId: number | null; detail: string }): Promise<MaintenanceIssue> {
  const [{ top }] = await db.select({ top: max(maintenanceIssues.number) }).from(maintenanceIssues).where(eq(maintenanceIssues.organizationId, values.organizationId));
  const [row] = await db
    .insert(maintenanceIssues)
    .values({ ...values, number: (top ?? 1000) + 1, updatedAt: values.firstReportedAt })
    .returning();
  await log(db, row.id, createdBy.userId, "created", createdBy.detail, values.firstReportedAt);
  return row;
}

// ---------- Checklist defects ----------

/** The item priority for a checklist defect (pure). */
export function defectPriority(severity: "minor" | "major", lockout: boolean): Priority {
  return severity === "major" ? (lockout ? "lockout" : "major") : "minor";
}

const reportLine = (d: { answerLabel: string; note?: string | null }) => `${d.answerLabel}${d.note ? `: ${d.note}` : ""}`;

/**
 * A check-in's defects become maintenance items. A defect already open on the machine is added to that item as
 * another report (count, latest answer; reported as more urgent, the item's priority goes up and it's marked with
 * this check-in, which raises a "Repair needed" alert again). Returns how many were new/escalated and how many repeats.
 * Runs inside the check-in's transaction.
 */
export async function recordChecklistDefects(
  db: DbLike,
  input: { organizationId: number; machineId: number; checkinId: number; defects: Defect[]; lockout: boolean; now: Date },
) {
  let raised = 0;
  let repeated = 0;
  const place = input.defects.length ? await machinePlace(db, input.machineId) : null;
  for (const d of input.defects) {
    const dedupeKey = `checklist:${d.questionId}`;
    const priority = defectPriority(d.severity, input.lockout);
    const [open] = await db
      .select()
      .from(maintenanceIssues)
      .where(and(eq(maintenanceIssues.machineId, input.machineId), eq(maintenanceIssues.dedupeKey, dedupeKey), isNull(maintenanceIssues.resolvedAt)));
    let issueId: number;
    if (!open) {
      const row = await insertIssue(
        db,
        {
          organizationId: input.organizationId,
          machineId: input.machineId,
          source: "checklist",
          priority,
          title: d.question,
          complaint: `Reported on a pre-start checklist: ${reportLine(d)}`,
          dedupeKey,
          questionId: d.questionId,
          section: d.section,
          severity: d.severity,
          answerLabel: d.answerLabel,
          note: d.note ?? null,
          firstReportedAt: input.now,
          lastReportedAt: input.now,
          firstCheckinId: input.checkinId,
          lastCheckinId: input.checkinId,
          alertCheckinId: input.checkinId,
          ...place,
        },
        { userId: null, detail: `Reported on checklist (check-in #${input.checkinId}): ${reportLine(d)}` },
      );
      issueId = row.id;
      raised++;
    } else {
      issueId = open.id;
      const escalated = priorityRank(priority) > priorityRank(open.priority);
      await db
        .update(maintenanceIssues)
        .set({
          reportCount: open.reportCount + 1,
          lastReportedAt: input.now,
          lastCheckinId: input.checkinId,
          answerLabel: d.answerLabel,
          note: d.note ?? open.note,
          updatedAt: input.now,
          ...(d.severity === "major" && open.severity !== "major" && { severity: "major" }),
          ...(escalated && { priority, alertCheckinId: input.checkinId }),
        })
        .where(eq(maintenanceIssues.id, open.id));
      await log(
        db,
        open.id,
        null,
        "reported_again",
        `Reported again on checklist (check-in #${input.checkinId}): ${reportLine(d)}${escalated ? `. Priority raised to ${PRIORITIES[priority].label}.` : ""}`,
        input.now,
      );
      if (escalated) raised++;
      else repeated++;
    }
    await db.insert(maintenanceReports).values({
      issueId,
      checkinId: input.checkinId,
      reportedAt: input.now,
      answerLabel: d.answerLabel,
      severity: d.severity,
      note: d.note ?? null,
    });
  }
  return { raised, repeated };
}

// ---------- Staff: add, edit, resolve, delete ----------

export async function createManualIssue(
  db: Db,
  organizationId: number,
  userId: number | null,
  input: { machineId: number; title: string; priority: string; complaint: string },
  now = new Date(),
) {
  const title = clean(input.title, 200);
  if (!title) throw new MaintenanceError("Enter a short title, e.g. \"Hydraulic leak at the boom\".");
  if (!isPriority(input.priority)) throw new MaintenanceError("Choose a priority.");
  const [machine] = await db
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.id, input.machineId), eq(machines.organizationId, organizationId)));
  if (!machine) throw new MaintenanceError("Choose a machine.");
  return insertIssue(
    db,
    {
      organizationId,
      machineId: machine.id,
      source: "manual",
      priority: input.priority,
      title,
      complaint: clean(input.complaint) ?? "",
      firstReportedAt: now,
      lastReportedAt: now,
      createdByUserId: userId,
      ...(await machinePlace(db, machine.id)),
    },
    { userId, detail: "Added" },
  );
}

async function issueInOrg(db: DbLike, organizationId: number, issueId: number) {
  const [issue] = await db
    .select()
    .from(maintenanceIssues)
    .where(and(eq(maintenanceIssues.id, issueId), eq(maintenanceIssues.organizationId, organizationId)));
  if (!issue) throw new MaintenanceError("That maintenance item doesn't exist.");
  return issue;
}

export type IssuePatch = {
  status?: string;
  priority?: string;
  title?: string;
  complaint?: string;
  cause?: string;
  correction?: string;
  performedBy?: string;
  vendorName?: string;
  servicedHours?: string;
  servicedKm?: string;
  servicedOn?: string;
};

const parseNum = (raw: string | undefined, label: string) => {
  if (raw === undefined) return undefined;
  const text = raw.replace(/[\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > MAINTENANCE_RULES.maxReading) throw new MaintenanceError(`Enter the ${label} as a number.`);
  return Math.round(n * 10) / 10;
};

/**
 * Saves changes to an item and logs them in words. Moving it to Resolved goes through the resolve rules (all three
 * C's; service items move their schedule on). Moving a resolved item back reopens it, unless a newer open item for
 * the same thing exists.
 */
export async function updateIssue(db: Db, organizationId: number, issueId: number, userId: number | null, patch: IssuePatch, now = new Date()) {
  const issue = await issueInOrg(db, organizationId, issueId);
  const set: Partial<typeof maintenanceIssues.$inferInsert> = {};
  const changes: string[] = [];
  if (patch.title !== undefined) {
    const title = clean(patch.title, 200);
    if (!title) throw new MaintenanceError("The title can't be empty.");
    if (title !== issue.title) {
      set.title = title;
      changes.push("title");
    }
  }
  for (const key of ["complaint", "cause", "correction"] as const) {
    if (patch[key] === undefined) continue;
    const value = key === "complaint" ? (clean(patch[key]) ?? "") : clean(patch[key]);
    if ((value ?? "") !== (issue[key] ?? "")) {
      set[key] = value as string;
      changes.push(SECTIONS[key].label.toLowerCase());
    }
  }
  if (patch.performedBy !== undefined) {
    const by = patch.performedBy === "internal" || patch.performedBy === "vendor" ? patch.performedBy : null;
    if (by !== issue.performedBy) {
      set.performedBy = by;
      changes.push("who did the work");
    }
  }
  if (patch.vendorName !== undefined) {
    const vendor = clean(patch.vendorName, 120);
    if (vendor !== issue.vendorName) {
      set.vendorName = vendor;
      changes.push("vendor");
    }
  }
  const hours = parseNum(patch.servicedHours, "hour meter reading");
  if (hours !== undefined && hours !== issue.servicedHours) set.servicedHours = hours;
  const km = parseNum(patch.servicedKm, "odometer reading");
  if (km !== undefined && km !== issue.servicedKm) set.servicedKm = km;
  if (patch.servicedOn !== undefined) {
    const on = patch.servicedOn.trim() || null;
    if (on && !/^\d{4}-\d{2}-\d{2}$/.test(on)) throw new MaintenanceError("Enter the service date.");
    if (on !== issue.servicedOn) set.servicedOn = on;
  }
  if (patch.priority !== undefined && patch.priority !== issue.priority) {
    if (!isPriority(patch.priority)) throw new MaintenanceError("Choose a priority.");
    set.priority = patch.priority;
    await log(db, issue.id, userId, "priority", `Priority: ${PRIORITIES[issue.priority as Priority]?.label ?? issue.priority} → ${PRIORITIES[patch.priority].label}`, now);
  }
  if (Object.keys(set).length) {
    await db.update(maintenanceIssues).set({ ...set, updatedAt: now }).where(eq(maintenanceIssues.id, issue.id));
    if (changes.length) await log(db, issue.id, userId, "edited", `Updated ${changes.join(", ")}`, now);
  }
  if (patch.status !== undefined && patch.status !== issue.status) {
    if (!isStatus(patch.status)) throw new MaintenanceError("Choose a status.");
    if (patch.status === "resolved") return resolveIssue(db, organizationId, issue.id, userId, now);
    if (issue.resolvedAt) await reopenIssue(db, issue, userId, patch.status, now);
    else {
      await db.update(maintenanceIssues).set({ status: patch.status, updatedAt: now }).where(eq(maintenanceIssues.id, issue.id));
      await log(db, issue.id, userId, "status", `Status: ${STATUSES[issue.status as Status]?.label ?? issue.status} → ${STATUSES[patch.status].label}`, now);
    }
  }
  return { ok: true as const };
}

async function reopenIssue(db: Db, issue: MaintenanceIssue, userId: number | null, status: Status, now: Date) {
  if (issue.dedupeKey) {
    const [newer] = await db
      .select({ number: maintenanceIssues.number })
      .from(maintenanceIssues)
      .where(and(eq(maintenanceIssues.machineId, issue.machineId), eq(maintenanceIssues.dedupeKey, issue.dedupeKey), isNull(maintenanceIssues.resolvedAt)));
    if (newer) throw new MaintenanceError(`It can't be reopened: #${newer.number} is already open for the same thing.`);
  }
  await db
    .update(maintenanceIssues)
    .set({ status, resolvedAt: null, resolvedByUserId: null, updatedAt: now })
    .where(eq(maintenanceIssues.id, issue.id));
  await log(db, issue.id, userId, "reopened", `Reopened: ${STATUSES[status].label}`, now);
}

/**
 * Resolves an item: needs the complaint, cause and correction. A service item records the machine's reading at the
 * service (the one entered, else the current one) and moves its schedule's next due on from there. Resolving the
 * last open "Locked out" item on a machine locked out for repair clears the lockout.
 */
export async function resolveIssue(db: Db, organizationId: number, issueId: number, userId: number | null, now = new Date()) {
  const issue = await issueInOrg(db, organizationId, issueId);
  if (issue.resolvedAt) return { ok: true as const };
  const missing = missingForResolve(issue);
  if (missing.length) throw new MaintenanceError(`Fill in ${missing.join(", ")} before resolving.`);
  const tz = await orgTimeZone(db, organizationId);
  const today = localDateKey(now.getTime(), tz);
  const notes: string[] = [];
  if (issue.scheduleId) {
    const [schedule] = await db.select().from(maintenanceSchedules).where(eq(maintenanceSchedules.id, issue.scheduleId));
    const current = (await currentReadings(db, [issue.machineId], now)).get(issue.machineId);
    const on = issue.servicedOn ?? today;
    const hours = issue.servicedHours ?? current?.hours?.value ?? null;
    const km = issue.servicedKm ?? current?.km?.value ?? null;
    await db.update(maintenanceIssues).set({ servicedOn: on, servicedHours: hours, servicedKm: km }).where(eq(maintenanceIssues.id, issue.id));
    // Readings typed in for the service count as readings.
    if (issue.servicedHours !== null) await recordReading(db, { organizationId, machineId: issue.machineId, kind: "hours", value: issue.servicedHours, source: "service", userId }, now);
    if (issue.servicedKm !== null) await recordReading(db, { organizationId, machineId: issue.machineId, kind: "km", value: issue.servicedKm, source: "service", userId }, now);
    if (schedule) {
      const next = nextDueFrom(schedule, { on, hours, km });
      await db.update(maintenanceSchedules).set({ ...next, lastServicedAt: now }).where(eq(maintenanceSchedules.id, schedule.id));
      notes.push(`Next service: ${[next.nextDueHours !== null && `${next.nextDueHours} h`, next.nextDueKm !== null && `${next.nextDueKm} km`, next.nextDueOn].filter(Boolean).join(" or ")}`);
    }
  }
  await db
    .update(maintenanceIssues)
    .set({ status: "resolved", resolvedAt: now, resolvedByUserId: userId, updatedAt: now })
    .where(eq(maintenanceIssues.id, issue.id));
  if (issue.priority === "lockout") {
    const [otherLockout] = await db
      .select({ id: maintenanceIssues.id })
      .from(maintenanceIssues)
      .where(and(eq(maintenanceIssues.machineId, issue.machineId), eq(maintenanceIssues.priority, "lockout"), isNull(maintenanceIssues.resolvedAt)));
    if (!otherLockout) {
      const cleared = await db
        .update(machines)
        .set({ lockedOutAt: null, lockedOutReason: null, lockedOutCheckinId: null })
        .where(and(eq(machines.id, issue.machineId), isNotNull(machines.lockedOutAt)))
        .returning({ id: machines.id });
      if (cleared.length) notes.push("Repair lockout cleared: operators can check in again");
    }
  }
  await log(db, issue.id, userId, "resolved", ["Resolved", ...notes].join(". "), now);
  return { ok: true as const };
}

/** Deletes an item and its attachments' records (returns the stored files' keys to delete). */
export async function deleteIssue(db: Db, organizationId: number, issueId: number) {
  const issue = await issueInOrg(db, organizationId, issueId);
  const files = await db.select({ key: maintenanceAttachments.storageKey }).from(maintenanceAttachments).where(eq(maintenanceAttachments.issueId, issue.id));
  await db.delete(maintenanceIssues).where(eq(maintenanceIssues.id, issue.id));
  return files.map((f) => f.key);
}

export async function addAttachment(
  db: Db,
  organizationId: number,
  issueId: number,
  userId: number | null,
  file: { section: string; storageKey: string; filename: string; contentType: string; bytes: number },
  now = new Date(),
) {
  const issue = await issueInOrg(db, organizationId, issueId);
  if (!(file.section in SECTIONS)) throw new MaintenanceError("Choose where the file belongs.");
  await db.insert(maintenanceAttachments).values({
    organizationId,
    issueId: issue.id,
    section: file.section,
    storageKey: file.storageKey,
    filename: file.filename.slice(0, 200) || "file",
    contentType: file.contentType,
    bytes: file.bytes,
    uploadedByUserId: userId,
    uploadedAt: now,
  });
  await log(db, issue.id, userId, "attachment", `Added ${file.filename.slice(0, 120)} to ${SECTIONS[file.section as Section].label}`, now);
}

/** Removes an attachment; returns its stored file's key to delete. */
export async function removeAttachment(db: Db, organizationId: number, attachmentId: number, userId: number | null, now = new Date()) {
  const [a] = await db
    .delete(maintenanceAttachments)
    .where(and(eq(maintenanceAttachments.id, attachmentId), eq(maintenanceAttachments.organizationId, organizationId)))
    .returning();
  if (!a) throw new MaintenanceError("That file doesn't exist.");
  await log(db, a.issueId, userId, "attachment", `Removed ${a.filename}`, now);
  return a.storageKey;
}

// ---------- Service schedules ----------

export type ScheduleInput = {
  machineId: number;
  description: string;
  everyDays?: string;
  everyHours?: string;
  everyKm?: string;
  /** The last time it was done (optional): the first due counts from here, otherwise from today / now. */
  lastDoneOn?: string;
  lastDoneHours?: string;
  lastDoneKm?: string;
  active?: boolean;
};

async function cleanSchedule(db: Db, organizationId: number, input: ScheduleInput, now: Date) {
  const description = clean(input.description, 120);
  if (!description) throw new MaintenanceError("Describe the service, e.g. \"250-hour service\".");
  const [machine] = await db
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.id, input.machineId), eq(machines.organizationId, organizationId)));
  if (!machine) throw new MaintenanceError("Choose a machine.");
  const days = parseNum(input.everyDays, "number of days") ?? null;
  const interval: Interval = {
    everyDays: days ? Math.round(days) : null,
    everyHours: parseNum(input.everyHours, "number of hours") || null,
    everyKm: parseNum(input.everyKm, "number of km") || null,
  };
  if (!interval.everyDays && !interval.everyHours && !interval.everyKm) throw new MaintenanceError("Set how often: every so many days, hours or km (or a mix).");
  const tz = await orgTimeZone(db, organizationId);
  const today = localDateKey(now.getTime(), tz);
  const lastOn = input.lastDoneOn?.trim() || null;
  if (lastOn && (!/^\d{4}-\d{2}-\d{2}$/.test(lastOn) || lastOn > today)) throw new MaintenanceError("The last service date can't be in the future.");
  const current = (await currentReadings(db, [machine.id], now)).get(machine.id);
  const from = {
    on: lastOn ?? today,
    hours: parseNum(input.lastDoneHours, "hours at the last service") ?? current?.hours?.value ?? null,
    km: parseNum(input.lastDoneKm, "km at the last service") ?? current?.km?.value ?? null,
  };
  return { machineId: machine.id, description, ...interval, ...nextDueFrom(interval, from), active: input.active ?? true };
}

export async function createSchedule(db: Db, organizationId: number, userId: number | null, input: ScheduleInput, now = new Date()) {
  const values = await cleanSchedule(db, organizationId, input, now);
  const [row] = await db
    .insert(maintenanceSchedules)
    .values({ organizationId, ...values, createdByUserId: userId, createdAt: now })
    .returning();
  await checkSchedules(db, now, organizationId);
  return row;
}

/** Changes a schedule. The next due is only worked out again when the interval or the last service changes. */
export async function updateSchedule(db: Db, organizationId: number, scheduleId: number, input: ScheduleInput, now = new Date()) {
  const [old] = await db
    .select()
    .from(maintenanceSchedules)
    .where(and(eq(maintenanceSchedules.id, scheduleId), eq(maintenanceSchedules.organizationId, organizationId)));
  if (!old) throw new MaintenanceError("That schedule doesn't exist.");
  const values = await cleanSchedule(db, organizationId, input, now);
  const sameTiming =
    values.machineId === old.machineId &&
    values.everyDays === old.everyDays &&
    values.everyHours === old.everyHours &&
    values.everyKm === old.everyKm &&
    !input.lastDoneOn &&
    !input.lastDoneHours &&
    !input.lastDoneKm;
  const { nextDueOn, nextDueHours, nextDueKm, ...rest } = values;
  await db
    .update(maintenanceSchedules)
    .set({ ...rest, ...(sameTiming ? {} : { nextDueOn, nextDueHours, nextDueKm }) })
    .where(eq(maintenanceSchedules.id, old.id));
  await checkSchedules(db, now, organizationId);
}

export async function deleteSchedule(db: Db, organizationId: number, scheduleId: number) {
  await db.delete(maintenanceSchedules).where(and(eq(maintenanceSchedules.id, scheduleId), eq(maintenanceSchedules.organizationId, organizationId)));
}

/** Opens the "Service due" item for a schedule, or returns the one already open. */
async function openServiceItem(db: Db, schedule: typeof maintenanceSchedules.$inferSelect, reason: string, userId: number | null, now: Date) {
  const dedupeKey = `schedule:${schedule.id}`;
  const [open] = await db
    .select()
    .from(maintenanceIssues)
    .where(and(eq(maintenanceIssues.machineId, schedule.machineId), eq(maintenanceIssues.dedupeKey, dedupeKey), isNull(maintenanceIssues.resolvedAt)));
  if (open) return { issue: open, created: false };
  const issue = await insertIssue(
    db,
    {
      organizationId: schedule.organizationId,
      machineId: schedule.machineId,
      source: "schedule",
      priority: "overdue_pm",
      title: `Service due: ${schedule.description}`,
      complaint: `${schedule.description} (${describeInterval(schedule).toLowerCase()}): ${reason}.`,
      dedupeKey,
      scheduleId: schedule.id,
      firstReportedAt: now,
      lastReportedAt: now,
      createdByUserId: userId,
      ...(await machinePlace(db, schedule.machineId)),
    },
    { userId, detail: userId ? "Service item opened by staff" : `Service came due: ${reason}` },
  );
  return { issue, created: true };
}

/** Staff open a schedule's service item now (before it's due). */
export async function openServiceNow(db: Db, organizationId: number, scheduleId: number, userId: number | null, now = new Date()) {
  const [schedule] = await db
    .select()
    .from(maintenanceSchedules)
    .where(and(eq(maintenanceSchedules.id, scheduleId), eq(maintenanceSchedules.organizationId, organizationId)));
  if (!schedule) throw new MaintenanceError("That schedule doesn't exist.");
  return openServiceItem(db, schedule, "opened early by staff", userId, now);
}

/**
 * Opens a "Service due" item for each active schedule that has come due (and records a Service Due notification
 * event). Every 5 minutes (watchdog), and after schedules or readings change.
 */
export async function checkSchedules(db: Db, now = new Date(), organizationId?: number) {
  const schedules = await db
    .select()
    .from(maintenanceSchedules)
    .where(and(eq(maintenanceSchedules.active, true), organizationId ? eq(maintenanceSchedules.organizationId, organizationId) : undefined));
  if (!schedules.length) return [];
  const readings = await currentReadings(db, [...new Set(schedules.map((s) => s.machineId))], now);
  const zones = new Map<number, string>();
  const opened: number[] = [];
  for (const s of schedules) {
    if (!zones.has(s.organizationId)) zones.set(s.organizationId, await orgTimeZone(db, s.organizationId));
    const r = readings.get(s.machineId);
    const state = dueState(s, localDateKey(now.getTime(), zones.get(s.organizationId)!), { hours: r?.hours?.value ?? null, km: r?.km?.value ?? null });
    if (state.state !== "due") continue;
    const reason = state.parts.filter((p) => p.state === "due").map(describeDuePart).join(", ");
    const { issue, created } = await openServiceItem(db, s, reason, null, now);
    if (!created) continue;
    opened.push(issue.id);
    await recordEvent(db, { organizationId: s.organizationId, machineId: s.machineId, type: "service_due", detail: `#${issue.number} ${s.description}: ${reason}`, occurredAt: now });
  }
  return opened;
}

// ---------- Devices gone quiet ----------

/**
 * A paired machine whose device hasn't reported for MAINTENANCE_RULES.offlineHours gets a "Device offline" item
 * (check the device, its wiring and the machine's battery). It's resolved automatically when the machine reports again.
 */
export async function checkConnectivity(db: Db, now = new Date()) {
  const cutoff = new Date(now.getTime() - MAINTENANCE_RULES.offlineHours * 3_600_000);
  const quiet = await db
    .select({ id: machines.id, organizationId: machines.organizationId, lastSeenAt: machines.lastSeenAt })
    .from(machines)
    .innerJoin(deviceAssignments, and(eq(deviceAssignments.machineId, machines.id), isNull(deviceAssignments.endedAt)))
    .where(and(isNotNull(machines.lastSeenAt), lt(machines.lastSeenAt, cutoff)));
  let opened = 0;
  for (const m of quiet) {
    const [open] = await db
      .select({ id: maintenanceIssues.id })
      .from(maintenanceIssues)
      .where(and(eq(maintenanceIssues.machineId, m.id), eq(maintenanceIssues.dedupeKey, "connectivity"), isNull(maintenanceIssues.resolvedAt)));
    if (open) continue;
    await insertIssue(
      db,
      {
        organizationId: m.organizationId,
        machineId: m.id,
        source: "connectivity",
        priority: "connectivity",
        title: `Device offline more than ${MAINTENANCE_RULES.offlineHours} h`,
        complaint:
          `The machine's device hasn't reported since ${m.lastSeenAt!.toISOString().slice(0, 16).replace("T", " ")} UTC. ` +
          "Check the machine's battery and the device's power and wiring, and whether the machine is out of coverage.",
        dedupeKey: "connectivity",
        firstReportedAt: now,
        lastReportedAt: now,
        ...(await machinePlace(db, m.id)),
      },
      { userId: null, detail: "Device stopped reporting" },
    );
    opened++;
  }
  // Back online: close it automatically.
  const back = await db
    .select({ issue: maintenanceIssues, lastSeenAt: machines.lastSeenAt })
    .from(maintenanceIssues)
    .innerJoin(machines, eq(machines.id, maintenanceIssues.machineId))
    .where(and(eq(maintenanceIssues.dedupeKey, "connectivity"), isNull(maintenanceIssues.resolvedAt), isNotNull(machines.lastSeenAt), sql`${machines.lastSeenAt} >= ${cutoff}`));
  for (const { issue, lastSeenAt } of back) {
    await db
      .update(maintenanceIssues)
      .set({
        status: "resolved",
        resolvedAt: now,
        updatedAt: now,
        cause: issue.cause ?? "Not diagnosed: the device started reporting again.",
        correction: issue.correction ?? `None needed: the device reported again at ${lastSeenAt!.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      })
      .where(eq(maintenanceIssues.id, issue.id));
    await log(db, issue.id, null, "resolved", "Resolved automatically: the device is reporting again", now);
  }
  return { opened, closed: back.length };
}

/** The maintenance checks the watchdog runs every 5 minutes. */
export async function runMaintenanceChecks(db: Db, now = new Date()) {
  const due = await checkSchedules(db, now);
  const connectivity = await checkConnectivity(db, now);
  return { serviceDue: due.length, offlineOpened: connectivity.opened, offlineClosed: connectivity.closed };
}

// ---------- Readings from staff ----------

/** A reading typed in by staff (machine page or a service schedule); then checks whether a service came due. */
export async function addReading(db: Db, organizationId: number, machineId: number, userId: number | null, kind: string, raw: string, now = new Date()) {
  if (kind !== "hours" && kind !== "km") throw new MaintenanceError("Choose hours or km.");
  const value = parseNum(raw, kind === "hours" ? "hour meter reading" : "odometer reading");
  if (value === null || value === undefined) throw new MaintenanceError("Enter the reading.");
  try {
    await recordReading(db, { organizationId, machineId, kind, value, source: "manual", userId }, now);
  } catch (e) {
    if (e instanceof MeterError) throw new MaintenanceError(e.message);
    throw e;
  }
  await checkSchedules(db, now, organizationId);
}

// ---------- Reads used by pages and privacy ----------

/** Open items (oldest first within priority) for an organization's machines, optionally some machines only. */
export async function openIssues(db: Db, organizationId: number, machineIds?: number[]) {
  if (machineIds && !machineIds.length) return [];
  return db
    .select()
    .from(maintenanceIssues)
    .where(and(eq(maintenanceIssues.organizationId, organizationId), isNull(maintenanceIssues.resolvedAt), machineIds ? inArray(maintenanceIssues.machineId, machineIds) : undefined))
    .orderBy(asc(maintenanceIssues.firstReportedAt));
}

