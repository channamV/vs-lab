import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  certificationTypes,
  machineCategories,
  machines,
  operators,
  organizations,
  trainingRecords,
  type CertificationType,
  type TrainingRecord,
} from "@/lib/db/schema";
import { deletePhotos } from "@/lib/photos";
import { recordEvent } from "@/lib/notifications";
import { sendEmail, senderSettings } from "@/lib/notify";
import { addDays, todayIn } from "@/lib/schedule-time";
import { daysBetween, recordStatus } from "@/lib/training-status";

export { defaultExpiry, recordStatus, STATUS_LABELS, type RecordStatus } from "@/lib/training-status";

/**
 * Operator training and certifications (docs/training.md). Companies keep a list of certification types (defaults
 * below, plus their own); managers add operators' records (with the certificate, optionally scanned). Each type
 * says which machines it covers (by category, or specific machines) and two things the company decides:
 *  - autoGrant: a valid record gives access to every covered machine (on top of approvals by hand);
 *  - required:  without a valid record, an operator can't check in on covered machines.
 * Access is worked out at check-in from the records' dates (nothing to switch off at expiry, nothing to undo on
 * renewal), and never stops someone mid-shift. Reminders go to managers (notifications) and the operator (email).
 */

export class TrainingError extends Error {}

/** Starter machine categories, in display order. Companies add their own. */
export const DEFAULT_CATEGORIES = [
  "Excavator",
  "Mini excavator",
  "Wheel loader",
  "Backhoe loader",
  "Skid steer / compact track loader",
  "Dozer",
  "Motor grader",
  "Compactor / roller",
  "Articulated / off-highway truck",
  "Dump truck (on-road)",
  "Telehandler",
  "Forklift",
  "Aerial work platform",
  "Mobile crane",
  "Pickup / light vehicle",
  "Other equipment",
];

/** Matching a machine's free-text type to a starter category (most specific first). */
const CATEGORY_HINTS: [RegExp, string][] = [
  [/mini.?ex|compact excavator/i, "Mini excavator"],
  [/backhoe/i, "Backhoe loader"],
  [/skid|track loader|\bctl\b|bobcat/i, "Skid steer / compact track loader"],
  [/telehandler|zoom boom|reach forklift/i, "Telehandler"],
  [/fork ?lift/i, "Forklift"],
  [/scissor|boom lift|aerial|\bawp\b|man ?lift/i, "Aerial work platform"],
  [/crane/i, "Mobile crane"],
  [/grader/i, "Motor grader"],
  [/dozer/i, "Dozer"],
  [/roller|compactor/i, "Compactor / roller"],
  [/articulated|rock truck|haul truck|off.?highway/i, "Articulated / off-highway truck"],
  [/dump truck|tri.?axle|tandem/i, "Dump truck (on-road)"],
  [/excavator|\bex\b|hoe/i, "Excavator"],
  [/loader/i, "Wheel loader"],
  [/pick.?up|truck|van|car/i, "Pickup / light vehicle"],
];
export const guessCategory = (machineType: string | null) => (machineType ? (CATEGORY_HINTS.find(([re]) => re.test(machineType))?.[1] ?? null) : null);

/**
 * Starter certification types, common on Canadian construction sites. Validity is the usual renewal period; companies
 * change it to match their province and policy. They start switched off: a manager turns each on and answers the
 * two access questions.
 */
export const DEFAULT_CERTIFICATIONS: { name: string; description: string; validityMonths: number | null; categories: string[] }[] = [
  { name: "Excavator operator", description: "Operator training and evaluation for excavators.", validityMonths: 36, categories: ["Excavator", "Mini excavator"] },
  { name: "Loader operator", description: "Wheel loaders and backhoe loaders.", validityMonths: 36, categories: ["Wheel loader", "Backhoe loader"] },
  { name: "Skid steer / compact loader operator", description: "Skid steers and compact track loaders.", validityMonths: 36, categories: ["Skid steer / compact track loader"] },
  { name: "Dozer operator", description: "", validityMonths: 36, categories: ["Dozer"] },
  { name: "Motor grader operator", description: "", validityMonths: 36, categories: ["Motor grader"] },
  { name: "Compactor / roller operator", description: "", validityMonths: 36, categories: ["Compactor / roller"] },
  { name: "Haul truck operator", description: "Articulated and off-highway trucks.", validityMonths: 36, categories: ["Articulated / off-highway truck"] },
  { name: "Telehandler operator (CSA B335)", description: "Lift truck training to CSA B335; re-evaluate at least every 3 years.", validityMonths: 36, categories: ["Telehandler"] },
  { name: "Forklift operator (CSA B335)", description: "Lift truck training to CSA B335; re-evaluate at least every 3 years.", validityMonths: 36, categories: ["Forklift"] },
  { name: "Aerial work platform (CSA B354)", description: "Boom and scissor lifts, CSA B354 operator training.", validityMonths: 36, categories: ["Aerial work platform"] },
  { name: "Mobile crane operator", description: "Provincial crane / hoisting certificate. Set the validity to your province's renewal period.", validityMonths: 36, categories: ["Mobile crane"] },
  { name: "Commercial driver's licence", description: "Class 1/3 (or AZ/DZ in Ontario) for on-road trucks. Use the licence's expiry date.", validityMonths: 60, categories: ["Dump truck (on-road)"] },
  { name: "Working at Heights", description: "Fall protection training (mandatory in Ontario, renew every 3 years).", validityMonths: 36, categories: [] },
  { name: "WHMIS", description: "Workplace hazardous materials; annual review recommended.", validityMonths: 12, categories: [] },
  { name: "First Aid / CPR", description: "Standard or emergency first aid with CPR.", validityMonths: 36, categories: [] },
  { name: "Ground disturbance", description: "Ground disturbance level 2 (common in Alberta and BC).", validityMonths: 36, categories: [] },
  { name: "Traffic control person", description: "Flagging / traffic control certification.", validityMonths: 36, categories: [] },
];

/** Creates the starter categories and certification types the first time they're needed. */
export async function ensureTrainingDefaults(db: Db, organizationId: number) {
  const existing = await db.select().from(machineCategories).where(eq(machineCategories.organizationId, organizationId));
  if (existing.length === 0) {
    await db
      .insert(machineCategories)
      .values(DEFAULT_CATEGORIES.map((name, i) => ({ organizationId, name, sortOrder: i })))
      .onConflictDoNothing();
    // Give existing machines a category from their free-text type where it's clear.
    const cats = await db.select().from(machineCategories).where(eq(machineCategories.organizationId, organizationId));
    const fleet = await db.select({ id: machines.id, machineType: machines.machineType, categoryId: machines.categoryId }).from(machines).where(eq(machines.organizationId, organizationId));
    for (const m of fleet) {
      const name = m.categoryId ? null : guessCategory(m.machineType);
      const cat = name && cats.find((c) => c.name === name);
      if (cat) await db.update(machines).set({ categoryId: cat.id }).where(eq(machines.id, m.id));
    }
  }
  const types = await db.select({ id: certificationTypes.id }).from(certificationTypes).where(eq(certificationTypes.organizationId, organizationId)).limit(1);
  if (types.length === 0) {
    const cats = await db.select().from(machineCategories).where(eq(machineCategories.organizationId, organizationId));
    await db
      .insert(certificationTypes)
      .values(
        DEFAULT_CERTIFICATIONS.map((c) => ({
          organizationId,
          name: c.name,
          description: c.description || null,
          validityMonths: c.validityMonths,
          categoryIds: cats.filter((x) => c.categories.includes(x.name)).map((x) => x.id),
          active: false,
        })),
      )
      .onConflictDoNothing();
  }
}

// ---------- categories ----------

export async function addCategory(db: Db, organizationId: number, rawName: string) {
  const name = rawName.trim().slice(0, 60);
  if (!name) throw new TrainingError("Enter the category's name.");
  const all = await db.select().from(machineCategories).where(eq(machineCategories.organizationId, organizationId));
  const taken = await db.select().from(machineCategories).where(and(eq(machineCategories.organizationId, organizationId), eq(machineCategories.name, name)));
  if (taken.length) throw new TrainingError(`There's already a category called "${name}".`);
  const [row] = await db
    .insert(machineCategories)
    .values({ organizationId, name, sortOrder: Math.max(0, ...all.map((c) => c.sortOrder)) + 1 })
    .returning();
  return row;
}

/** Deleting a category takes it off machines and certification types. */
export async function deleteCategory(db: Db, organizationId: number, id: number) {
  const [cat] = await db.select().from(machineCategories).where(and(eq(machineCategories.id, id), eq(machineCategories.organizationId, organizationId)));
  if (!cat) throw new TrainingError("Category not found.");
  await db.update(machines).set({ categoryId: null }).where(and(eq(machines.organizationId, organizationId), eq(machines.categoryId, id)));
  const types = await db.select().from(certificationTypes).where(eq(certificationTypes.organizationId, organizationId));
  for (const t of types.filter((t) => t.categoryIds.includes(id))) {
    await db.update(certificationTypes).set({ categoryIds: t.categoryIds.filter((c) => c !== id) }).where(eq(certificationTypes.id, t.id));
  }
  await db.delete(machineCategories).where(eq(machineCategories.id, id));
}

// ---------- certification types ----------

export type CertificationInput = {
  name: string;
  description: string;
  validityMonths: number | null;
  categoryIds: number[];
  machineIds: number[];
  /** Both must be answered (Craig, 2026-10-22): null = not answered. */
  autoGrant: boolean | null;
  required: boolean | null;
  graceDays: number;
  reminderDays: number[];
  active: boolean;
};

async function cleanCertification(db: Db, organizationId: number, input: CertificationInput, exceptId?: number) {
  const name = input.name.trim().slice(0, 100);
  if (!name) throw new TrainingError("Enter the certification's name.");
  if (input.autoGrant === null || input.required === null) throw new TrainingError("Answer both access questions (Yes or No).");
  if (input.validityMonths !== null && (!Number.isInteger(input.validityMonths) || input.validityMonths < 1 || input.validityMonths > 240)) {
    throw new TrainingError("Validity must be 1–240 months, or blank if it doesn't expire.");
  }
  if (!Number.isInteger(input.graceDays) || input.graceDays < 0 || input.graceDays > 90) throw new TrainingError("The grace period must be 0–90 days.");
  const reminderDays = [...new Set(input.reminderDays)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 365).sort((a, b) => b - a);
  const [cats, fleet, same] = await Promise.all([
    db.select({ id: machineCategories.id }).from(machineCategories).where(eq(machineCategories.organizationId, organizationId)),
    db.select({ id: machines.id }).from(machines).where(eq(machines.organizationId, organizationId)),
    db.select({ id: certificationTypes.id }).from(certificationTypes).where(and(eq(certificationTypes.organizationId, organizationId), eq(certificationTypes.name, name))),
  ]);
  if (same.some((s) => s.id !== exceptId)) throw new TrainingError(`There's already a certification called "${name}".`);
  const catIds = new Set(cats.map((c) => c.id));
  const machineIds = new Set(fleet.map((m) => m.id));
  if (input.categoryIds.some((id) => !catIds.has(id)) || input.machineIds.some((id) => !machineIds.has(id))) throw new TrainingError("Check the machines it covers.");
  if ((input.autoGrant || input.required) && !input.categoryIds.length && !input.machineIds.length) {
    throw new TrainingError("Choose the machines or categories it covers, or answer No to both access questions.");
  }
  return {
    name,
    description: input.description.trim().slice(0, 500) || null,
    validityMonths: input.validityMonths,
    categoryIds: [...new Set(input.categoryIds)],
    machineIds: [...new Set(input.machineIds)],
    autoGrant: input.autoGrant,
    required: input.required,
    graceDays: input.graceDays,
    reminderDays,
    active: input.active,
  };
}

export async function createCertificationType(db: Db, organizationId: number, input: CertificationInput) {
  const values = await cleanCertification(db, organizationId, input);
  const [row] = await db.insert(certificationTypes).values({ organizationId, ...values }).returning();
  return row;
}

export async function updateCertificationType(db: Db, organizationId: number, id: number, input: CertificationInput) {
  const [existing] = await db.select().from(certificationTypes).where(and(eq(certificationTypes.id, id), eq(certificationTypes.organizationId, organizationId)));
  if (!existing) throw new TrainingError("Certification not found.");
  await db.update(certificationTypes).set(await cleanCertification(db, organizationId, input, id)).where(eq(certificationTypes.id, id));
}

// ---------- records ----------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type RecordInput = {
  certificationTypeId: number;
  issuedOn: string;
  expiresOn: string | null;
  provider: string;
  certificateNumber: string;
  notes: string;
};

async function cleanRecord(db: Db, organizationId: number, operatorId: number, input: RecordInput) {
  const [op] = await db.select().from(operators).where(and(eq(operators.id, operatorId), eq(operators.organizationId, organizationId)));
  if (!op || op.erasedAt) throw new TrainingError("Operator not found.");
  const [type] = await db.select().from(certificationTypes).where(and(eq(certificationTypes.id, input.certificationTypeId), eq(certificationTypes.organizationId, organizationId)));
  if (!type) throw new TrainingError("Choose the certification.");
  if (!DATE.test(input.issuedOn)) throw new TrainingError("Enter the date it was issued.");
  if (input.expiresOn && !DATE.test(input.expiresOn)) throw new TrainingError("Check the expiry date.");
  if (input.expiresOn && input.expiresOn <= input.issuedOn) throw new TrainingError("The expiry date must be after the issue date.");
  return {
    certificationTypeId: type.id,
    issuedOn: input.issuedOn,
    expiresOn: input.expiresOn || null,
    provider: input.provider.trim().slice(0, 120) || null,
    certificateNumber: input.certificateNumber.trim().slice(0, 80) || null,
    notes: input.notes.trim().slice(0, 500) || null,
  };
}

/** A manager adds a record (managers' entries need no further approval). The document's key comes from saveDocument. */
export async function addTrainingRecord(
  db: Db,
  organizationId: number,
  operatorId: number,
  input: RecordInput,
  enteredBy: { userId: number | null; email: string },
  document: { key: string; contentType: string } | null = null,
  now = new Date(),
) {
  const values = await cleanRecord(db, organizationId, operatorId, input);
  const [row] = await db
    .insert(trainingRecords)
    .values({
      organizationId,
      operatorId,
      ...values,
      documentKey: document?.key ?? null,
      documentType: document?.contentType ?? null,
      enteredBy: enteredBy.email,
      enteredByUserId: enteredBy.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

/** `document` replaces the stored certificate (the old file is deleted). */
export async function updateTrainingRecord(
  db: Db,
  organizationId: number,
  id: number,
  input: RecordInput,
  document: { key: string; contentType: string } | null = null,
  now = new Date(),
) {
  const [existing] = await db.select().from(trainingRecords).where(and(eq(trainingRecords.id, id), eq(trainingRecords.organizationId, organizationId)));
  if (!existing) throw new TrainingError("Record not found.");
  const values = await cleanRecord(db, organizationId, existing.operatorId, input);
  // A new expiry date starts its reminders again.
  const renewed = values.expiresOn !== existing.expiresOn;
  await db
    .update(trainingRecords)
    .set({
      ...values,
      updatedAt: now,
      ...(renewed && { remindedDays: null, expiredNotifiedAt: null }),
      ...(document && { documentKey: document.key, documentType: document.contentType }),
    })
    .where(eq(trainingRecords.id, id));
  if (document && existing.documentKey) await deletePhotos([existing.documentKey]);
  return existing.operatorId;
}

export async function deleteTrainingRecord(db: Db, organizationId: number, id: number) {
  const [existing] = await db.select().from(trainingRecords).where(and(eq(trainingRecords.id, id), eq(trainingRecords.organizationId, organizationId)));
  if (!existing) throw new TrainingError("Record not found.");
  if (existing.documentKey) await deletePhotos([existing.documentKey]);
  await db.delete(trainingRecords).where(eq(trainingRecords.id, id));
}

// ---------- status ----------

/** Whether expiry date `a` is later than `b` (no expiry counts as latest). */
const laterExpiry = (a: string | null, b: string | null) => (a === null ? b !== null : b !== null && a > b);

/** Each operator's latest record of each certification: a renewal replaces the old record. */
export function latestRecords<T>(rows: T[], record: (row: T) => Pick<TrainingRecord, "operatorId" | "certificationTypeId" | "expiresOn">): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const r = record(row);
    const key = `${r.operatorId}:${r.certificationTypeId}`;
    const prev = latest.get(key);
    if (!prev || laterExpiry(r.expiresOn, record(prev).expiresOn)) latest.set(key, row);
  }
  return [...latest.values()];
}

/** The certification types that cover this machine (by category or by name). */
const covers = (t: CertificationType, machine: { id: number; categoryId: number | null }) =>
  t.machineIds.includes(machine.id) || (machine.categoryId !== null && t.categoryIds.includes(machine.categoryId));

/**
 * Training's say on an operator starting a machine: granted = a valid record of an auto-grant certification covers
 * it; missing = required certifications covering it that the operator doesn't hold (valid or in grace).
 */
export async function trainingAccess(db: Db, organizationId: number, machine: { id: number; categoryId: number | null }, operatorId: number, now = new Date()) {
  const [org] = await db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, organizationId));
  const today = todayIn(org?.timezone ?? "America/Toronto", now.getTime());
  const types = (await db.select().from(certificationTypes).where(and(eq(certificationTypes.organizationId, organizationId), eq(certificationTypes.active, true)))).filter((t) =>
    covers(t, machine),
  );
  if (!types.length) return { granted: false, missing: [] as string[] };
  const records = await db
    .select()
    .from(trainingRecords)
    .where(and(eq(trainingRecords.operatorId, operatorId), inArray(trainingRecords.certificationTypeId, types.map((t) => t.id))));
  const holds = (t: CertificationType) => records.some((r) => r.certificationTypeId === t.id && recordStatus(r, t, today).counts);
  return {
    granted: types.some((t) => t.autoGrant && holds(t)),
    missing: types.filter((t) => t.required && !holds(t)).map((t) => t.name),
  };
}

// ---------- reminders ----------

/**
 * Expiry reminders (from the watchdog, every 5 minutes; each is sent once): at each of the type's "days before"
 * and when it expires, a notification event for managers (Training Expiring / Training Expired) and an email to
 * the operator if they have an address. Only an operator's latest record of each certification counts.
 */
export async function sendTrainingReminders(db: Db, now = new Date()) {
  const rows = await db
    .select({ r: trainingRecords, t: certificationTypes, op: operators, tz: organizations.timezone })
    .from(trainingRecords)
    .innerJoin(certificationTypes, eq(certificationTypes.id, trainingRecords.certificationTypeId))
    .innerJoin(operators, eq(operators.id, trainingRecords.operatorId))
    .innerJoin(organizations, eq(organizations.id, trainingRecords.organizationId))
    .where(and(eq(certificationTypes.active, true), eq(operators.active, true)));
  const sender = senderSettings();
  const events: number[] = [];
  for (const { r, t, op, tz } of latestRecords(rows, (row) => row.r)) {
    if (!r.expiresOn) continue;
    const today = todayIn(tz, now.getTime());
    const daysLeft = daysBetween(today, r.expiresOn);
    let kind: "expiring" | "expired" | null = null;
    if (daysLeft < 0) {
      if (!r.expiredNotifiedAt) {
        kind = "expired";
        await db.update(trainingRecords).set({ expiredNotifiedAt: now }).where(eq(trainingRecords.id, r.id));
      }
    } else {
      const due = [...t.reminderDays].sort((a, b) => a - b).find((d) => daysLeft <= d);
      if (due !== undefined && (r.remindedDays === null || due < r.remindedDays)) {
        kind = "expiring";
        await db.update(trainingRecords).set({ remindedDays: due }).where(eq(trainingRecords.id, r.id));
      }
    }
    if (!kind) continue;
    const grace = kind === "expired" && t.graceDays ? ` It still counts for ${t.graceDays} days (grace period) until ${addDays(r.expiresOn, t.graceDays)}.` : "";
    const access = t.required ? " It's required for some machines: without it, the operator can't check in on them." : "";
    const detail =
      kind === "expired"
        ? `${op.name}'s ${t.name} expired on ${r.expiresOn}.${grace}${access}`
        : `${op.name}'s ${t.name} expires on ${r.expiresOn} (in ${daysLeft} day${daysLeft === 1 ? "" : "s"}).${access}`;
    const id = await recordEvent(db, {
      organizationId: r.organizationId,
      machineId: null,
      type: kind === "expired" ? "training_expired" : "training_expiring",
      operatorId: op.id,
      detail,
      occurredAt: now,
    });
    if (id) events.push(id);
    if (sender && op.email) {
      await sendEmail(sender, [op.email], {
        subject: kind === "expired" ? `Your ${t.name} has expired` : `Your ${t.name} expires on ${r.expiresOn}`,
        text: [
          `Hello ${op.name},`,
          "",
          kind === "expired"
            ? `Your ${t.name} expired on ${r.expiresOn}.${grace} Please arrange a renewal with your supervisor.`
            : `Your ${t.name} expires on ${r.expiresOn}, in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Please arrange a renewal with your supervisor.`,
          "",
          "— Sent by VS Lab for your employer",
        ].join("\n"),
      });
    }
  }
  return events;
}
