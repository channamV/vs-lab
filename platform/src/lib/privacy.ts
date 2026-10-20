import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  alerts,
  auditLog,
  checkinPhotos,
  checkins,
  checklistIssues,
  deviceEvents,
  deviceIncidents,
  loginTokens,
  machineOperators,
  machines,
  notificationEvents,
  operators,
  organizations,
  pinFailures,
  sessions,
  telemetry,
  type ChecklistAnswer,
  type Organization,
} from "@/lib/db/schema";
import { deletePhotos } from "@/lib/photos";
import { RETENTION_KEYS, RETENTION_LIMITS, type RetentionKey } from "@/lib/privacy-limits";

/**
 * Privacy (GDPR) tools: how long each kind of personal data is kept, the nightly clean-up that applies
 * it, exporting everything about an operator, erasing an operator, and the audit log customers see.
 * See docs/privacy.md.
 */

export class PrivacyError extends Error {}

export { RETENTION_KEYS, RETENTION_LIMITS, type RetentionKey } from "@/lib/privacy-limits";

/** Data from devices that aren't on a machine (bench tests, stock) has no customer: kept this long. */
export const UNPAIRED_TELEMETRY_DAYS = 730;
/** Rows deleted per statement, and statements per table per run (the rest goes the next night). */
const BATCH = 20_000;
const MAX_BATCHES = 25;

export async function updatePrivacySettings(
  db: Db,
  organizationId: number,
  input: { privacyContact: string } & Record<RetentionKey, number>,
) {
  const changes: Partial<Organization> = { privacyContact: input.privacyContact.trim().slice(0, 200) || null };
  for (const key of RETENTION_KEYS) {
    const { min, max, label } = RETENTION_LIMITS[key];
    const days = input[key];
    if (!Number.isInteger(days) || days < min || days > max) {
      throw new PrivacyError(`${label}: keep between ${min} and ${max} days.`);
    }
    changes[key] = days;
  }
  await db.update(organizations).set(changes).where(eq(organizations.id, organizationId));
}

export async function logAudit(
  db: Db,
  entry: { organizationId: number; actor: string; staff?: boolean; action: "staff-view" | "operator-export" | "operator-erase"; detail?: string },
  now = new Date(),
) {
  await db.insert(auditLog).values({ ...entry, staff: entry.staff ?? false, at: now });
}

export async function auditEntries(db: Db, organizationId: number, limit = 100) {
  return db.select().from(auditLog).where(eq(auditLog.organizationId, organizationId)).orderBy(desc(auditLog.at)).limit(limit);
}

const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

/** Deletes rows matching `where` from a table with an id column, in batches. Returns how many. */
async function deleteInBatches(
  db: Db,
  table: typeof telemetry | typeof deviceEvents,
  where: ReturnType<typeof and>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const ids = db.select({ id: table.id }).from(table).where(where).limit(BATCH);
    const deleted = await db.delete(table).where(inArray(table.id, ids)).returning({ id: table.id });
    total += deleted.length;
    if (deleted.length < BATCH) break;
  }
  return total;
}

export type RetentionResult = {
  phoneLocationsCleared: number;
  photosDeleted: number;
  telemetryDeleted: number;
  deviceEventsDeleted: number;
  incidentsDeleted: number;
  checkinsDeleted: number;
  alertsDeleted: number;
  issuesDeleted: number;
  notificationsDeleted: number;
  sessionsDeleted: number;
};

/**
 * The nightly clean-up: removes personal data older than each organization's retention settings, plus
 * expired sign-in sessions, used sign-in links and old wrong-PIN records. Safe to run any number of times.
 */
export async function applyRetention(db: Db, now = new Date()): Promise<RetentionResult> {
  const r: RetentionResult = {
    phoneLocationsCleared: 0,
    photosDeleted: 0,
    telemetryDeleted: 0,
    deviceEventsDeleted: 0,
    incidentsDeleted: 0,
    checkinsDeleted: 0,
    alertsDeleted: 0,
    issuesDeleted: 0,
    notificationsDeleted: 0,
    sessionsDeleted: 0,
  };
  const orgs = await db.select().from(organizations).orderBy(asc(organizations.id));
  for (const org of orgs) {
    const orgMachines = db.select({ id: machines.id }).from(machines).where(eq(machines.organizationId, org.id));

    // Phone location: the position goes; the result of the check (near / far) and the distance stay.
    const location = daysBefore(now, org.retainPhoneLocationDays);
    r.phoneLocationsCleared += (
      await db
        .update(checkins)
        .set({ phoneLat: null, phoneLng: null, phoneAccuracyM: null })
        .where(and(eq(checkins.organizationId, org.id), lt(checkins.startedAt, location), isNotNull(checkins.phoneLat)))
        .returning({ id: checkins.id })
    ).length;

    // Photos (and, below, the photos of check-ins being deleted).
    const checkinCutoff = daysBefore(now, org.retainCheckinDays);
    const oldPhotos = await db
      .select({ id: checkinPhotos.id, key: checkinPhotos.storageKey })
      .from(checkinPhotos)
      .innerJoin(checkins, eq(checkins.id, checkinPhotos.checkinId))
      .where(
        and(
          eq(checkinPhotos.organizationId, org.id),
          or(lt(checkinPhotos.takenAt, daysBefore(now, org.retainPhotoDays)), and(isNotNull(checkins.endedAt), lt(checkins.startedAt, checkinCutoff))),
        ),
      )
      .limit(1000);
    if (oldPhotos.length) {
      // Files first: if that fails, the rows stay and the next run tries again.
      await deletePhotos(oldPhotos.map((p) => p.key));
      await db.delete(checkinPhotos).where(inArray(checkinPhotos.id, oldPhotos.map((p) => p.id)));
      r.photosDeleted += oldPhotos.length;
    }

    // GPS track, connectivity events and resolved tamper/connectivity incidents.
    const track = daysBefore(now, org.retainTelemetryDays);
    r.telemetryDeleted += await deleteInBatches(db, telemetry, and(inArray(telemetry.machineId, orgMachines), lt(telemetry.receivedAt, track)));
    r.deviceEventsDeleted += await deleteInBatches(db, deviceEvents, and(inArray(deviceEvents.machineId, orgMachines), lt(deviceEvents.at, track)));
    r.incidentsDeleted += (
      await db
        .delete(deviceIncidents)
        .where(and(eq(deviceIncidents.organizationId, org.id), isNotNull(deviceIncidents.resolvedAt), lt(deviceIncidents.resolvedAt, track)))
        .returning({ id: deviceIncidents.id })
    ).length;

    // Alerts, resolved defects and finished check-ins. Open defects and a current check-in always stay.
    r.alertsDeleted += (
      await db
        .delete(alerts)
        .where(and(eq(alerts.organizationId, org.id), lt(alerts.createdAt, checkinCutoff)))
        .returning({ id: alerts.id })
    ).length;
    r.issuesDeleted += (
      await db
        .delete(checklistIssues)
        .where(and(eq(checklistIssues.organizationId, org.id), isNotNull(checklistIssues.resolvedAt), lt(checklistIssues.resolvedAt, checkinCutoff)))
        .returning({ id: checklistIssues.id })
    ).length;
    if (oldPhotos.length < 1000) {
      // (Only once their photos are gone: deleting a check-in deletes its photo rows, not the files.)
      r.checkinsDeleted += (
        await db
          .delete(checkins)
          .where(and(eq(checkins.organizationId, org.id), isNotNull(checkins.endedAt), lt(checkins.startedAt, checkinCutoff)))
          .returning({ id: checkins.id })
      ).length;
    }

    // Notification history (deliveries go with their event).
    r.notificationsDeleted += (
      await db
        .delete(notificationEvents)
        .where(
          and(
            eq(notificationEvents.organizationId, org.id),
            isNotNull(notificationEvents.processedAt),
            lt(notificationEvents.occurredAt, daysBefore(now, org.retainNotificationDays)),
          ),
        )
        .returning({ id: notificationEvents.id })
    ).length;
  }

  // Data from devices that weren't on a machine.
  const unpaired = daysBefore(now, UNPAIRED_TELEMETRY_DAYS);
  r.telemetryDeleted += await deleteInBatches(db, telemetry, and(isNull(telemetry.machineId), lt(telemetry.receivedAt, unpaired)));
  r.deviceEventsDeleted += await deleteInBatches(db, deviceEvents, and(isNull(deviceEvents.machineId), lt(deviceEvents.at, unpaired)));

  // Sign-in housekeeping.
  const yesterday = daysBefore(now, 1);
  r.sessionsDeleted += (await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id })).length;
  await db.delete(loginTokens).where(lt(loginTokens.expiresAt, yesterday));
  await db.delete(pinFailures).where(lt(pinFailures.at, yesterday));
  return r;
}

async function findOperator(db: Db, organizationId: number, operatorId: number) {
  const [op] = await db
    .select()
    .from(operators)
    .where(and(eq(operators.id, operatorId), eq(operators.organizationId, organizationId)));
  if (!op) throw new PrivacyError("Operator not found.");
  return op;
}

/**
 * Everything stored about an operator (a data subject access request, GDPR article 15), as plain data
 * for a JSON download. The PIN is only stored as a one-way hash, so it isn't included.
 */
export async function exportOperator(db: Db, organizationId: number, operatorId: number, now = new Date()) {
  const op = await findOperator(db, organizationId, operatorId);
  const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  const approved = await db
    .select({ name: machines.name, unitNumber: machines.unitNumber })
    .from(machineOperators)
    .innerJoin(machines, eq(machines.id, machineOperators.machineId))
    .where(eq(machineOperators.operatorId, op.id))
    .orderBy(asc(machines.name));
  const rows = await db
    .select({ checkin: checkins, machine: machines.name, unitNumber: machines.unitNumber })
    .from(checkins)
    .innerJoin(machines, eq(machines.id, checkins.machineId))
    .where(and(eq(checkins.operatorId, op.id), eq(checkins.organizationId, organizationId)))
    .orderBy(asc(checkins.startedAt));
  const checkinIds = rows.map((r) => r.checkin.id);
  const [photos, alertRows, events] = await Promise.all([
    checkinIds.length
      ? db.select().from(checkinPhotos).where(inArray(checkinPhotos.checkinId, checkinIds)).orderBy(asc(checkinPhotos.id))
      : [],
    checkinIds.length
      ? db.select().from(alerts).where(inArray(alerts.checkinId, checkinIds)).orderBy(asc(alerts.createdAt))
      : [],
    db
      .select({ event: notificationEvents, machine: machines.name })
      .from(notificationEvents)
      .innerJoin(machines, eq(machines.id, notificationEvents.machineId))
      .where(and(eq(notificationEvents.operatorId, op.id), eq(notificationEvents.organizationId, organizationId)))
      .orderBy(asc(notificationEvents.occurredAt)),
  ]);
  const photosFor = Map.groupBy(photos, (p) => p.checkinId);
  return {
    exportedAt: now.toISOString(),
    organization: org?.name ?? null,
    privacyContact: org?.privacyContact ?? null,
    about:
      "Everything this system stores about the operator. The PIN is stored only as a one-way code and can't be shown. " +
      "Photos are listed; open each link while signed in to download it.",
    operator: {
      id: op.id,
      name: op.name,
      employeeNumber: op.employeeNumber,
      active: op.active,
      addedAt: op.createdAt.toISOString(),
      erasedAt: op.erasedAt?.toISOString() ?? null,
      approvedMachines: approved.map((m) => (m.unitNumber ? `Unit ${m.unitNumber} · ${m.name}` : m.name)),
    },
    checkins: rows.map(({ checkin: c, machine, unitNumber }) => ({
      id: c.id,
      machine: unitNumber ? `Unit ${unitNumber} · ${machine}` : machine,
      startedAt: c.startedAt.toISOString(),
      endedAt: c.endedAt?.toISOString() ?? null,
      endReason: c.endReason,
      method: c.method,
      approvedForMachine: c.authorized,
      checklistOk: c.checklistOk,
      checklist: c.templateName,
      answers: c.answers,
      notes: c.notes,
      confirmation: c.confirmationText,
      lockoutRequested: c.lockoutRequested,
      phoneLocation: c.phoneLat !== null && c.phoneLng !== null ? { lat: c.phoneLat, lng: c.phoneLng, accuracyM: c.phoneAccuracyM } : null,
      distanceFromMachineM: c.distanceM,
      locationCheck: c.locationCheck,
      photos: (photosFor.get(c.id) ?? []).map((p) => ({ question: p.questionId, takenAt: p.takenAt.toISOString(), link: `/photos/${p.id}` })),
    })),
    alerts: alertRows.map((a) => ({ at: a.createdAt.toISOString(), type: a.type, title: a.title, detail: a.detail })),
    notifications: events.map(({ event, machine }) => ({ at: event.occurredAt.toISOString(), type: event.type, machine, detail: event.detail })),
  };
}

/** Replaces a name as a whole word (not inside another word), whatever surrounds it. */
export function replaceName(text: string, name: string, replacement: string): string;
export function replaceName(text: string | null, name: string, replacement: string): string | null;
export function replaceName(text: string | null, name: string, replacement: string): string | null {
  if (!text || !name.trim()) return text;
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"), replacement);
}

/**
 * Erases an operator's personal data (right to erasure, GDPR article 17) while keeping the machine's
 * records: check-ins, checklist answers, defects and alerts stay, attributed to "Former operator #id".
 * Removes the name, employee number and PIN, approvals, phone locations and checklist photos, and
 * replaces the name wherever it was written into alerts, defects, lockouts and notifications.
 */
export async function eraseOperator(db: Db, organizationId: number, operatorId: number, now = new Date()) {
  const op = await findOperator(db, organizationId, operatorId);
  if (op.erasedAt) throw new PrivacyError("This operator has already been erased.");
  const placeholder = `Former operator #${op.id}`;
  const scrub = <T extends string | null>(text: T) => replaceName(text, op.name, placeholder) as T;

  const theirs = await db
    .select()
    .from(checkins)
    .where(and(eq(checkins.operatorId, op.id), eq(checkins.organizationId, organizationId)));
  const checkinIds = theirs.map((c) => c.id);

  // Photo files first: if deleting them fails, nothing has changed yet and it can be tried again.
  const photos = checkinIds.length
    ? await db.select({ id: checkinPhotos.id, key: checkinPhotos.storageKey }).from(checkinPhotos).where(inArray(checkinPhotos.checkinId, checkinIds))
    : [];
  await deletePhotos(photos.map((p) => p.key));

  await db.transaction(async (tx) => {
    if (photos.length) await tx.delete(checkinPhotos).where(inArray(checkinPhotos.id, photos.map((p) => p.id)));
    for (const c of theirs) {
      await tx
        .update(checkins)
        .set({
          phoneLat: null,
          phoneLng: null,
          phoneAccuracyM: null,
          notes: scrub(c.notes),
          answers: c.answers.map((a: ChecklistAnswer) => (a.note ? { ...a, note: scrub(a.note) } : a)),
          ...(c.endedAt ? {} : { endedAt: now, endReason: "erased" }),
        })
        .where(eq(checkins.id, c.id));
    }
    if (checkinIds.length) {
      const theirAlerts = await tx.select().from(alerts).where(inArray(alerts.checkinId, checkinIds));
      for (const a of theirAlerts) {
        await tx.update(alerts).set({ title: scrub(a.title), detail: scrub(a.detail), ackNote: scrub(a.ackNote) }).where(eq(alerts.id, a.id));
      }
      const issues = await tx
        .select()
        .from(checklistIssues)
        .where(or(inArray(checklistIssues.firstCheckinId, checkinIds), inArray(checklistIssues.lastCheckinId, checkinIds)));
      for (const i of issues) {
        await tx.update(checklistIssues).set({ note: scrub(i.note) }).where(eq(checklistIssues.id, i.id));
      }
      const locked = await tx.select().from(machines).where(inArray(machines.lockedOutCheckinId, checkinIds));
      for (const m of locked) {
        await tx.update(machines).set({ lockedOutReason: scrub(m.lockedOutReason) }).where(eq(machines.id, m.id));
      }
    }
    const events = await tx.select().from(notificationEvents).where(eq(notificationEvents.operatorId, op.id));
    for (const e of events) {
      if (e.detail) await tx.update(notificationEvents).set({ detail: scrub(e.detail) }).where(eq(notificationEvents.id, e.id));
    }
    await tx.delete(machineOperators).where(eq(machineOperators.operatorId, op.id));
    await tx
      .update(operators)
      .set({
        name: placeholder,
        employeeNumber: null,
        active: false,
        // Not a hash of any PIN, so nobody can check in as this operator again.
        pinHash: `erased:${randomBytes(16).toString("hex")}`,
        erasedAt: now,
      })
      .where(eq(operators.id, op.id));
  });
  return { checkins: theirs.length, photosDeleted: photos.length, placeholder };
}
