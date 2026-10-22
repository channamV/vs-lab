"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { deletePhotos, photoStorageAvailable, saveDocument } from "@/lib/photos";
import { requireAuth } from "@/lib/session";
import { and, eq } from "drizzle-orm";
import { certificationTypes, operators } from "@/lib/db/schema";
import { sameName, scanAvailable, ScanError, scanTrainingCertificate, type TrainingFields } from "@/lib/scan";
import {
  addCategory,
  addTrainingRecord,
  createCertificationType,
  deleteCategory,
  deleteTrainingRecord,
  TrainingError,
  updateCertificationType,
  updateTrainingRecord,
} from "@/lib/training";

/**
 * Training. Certification types and machine categories: whole-company managers and owners (like checklists).
 * Training records: any manager or owner (operators are company-wide); a manager's entry needs no approval.
 */

/** `values` refills the form after an error (React clears it after every submit); `version` re-keys it. */
export type TrainingFormState = { error: string | null; version: number; values?: Record<string, string | string[]> };

async function requireTypeEditor() {
  const auth = await requireAuth("manager");
  if (auth.divisionIds !== null) throw new TrainingError("Only managers with access to the whole company can change certifications and categories.");
  return auth;
}

const id = z.coerce.number().int().positive();
const ids = (values: FormDataEntryValue[]) => values.map((v) => Number(v)).filter((n) => Number.isSafeInteger(n) && n > 0);
const yesNo = (v: FormDataEntryValue | null) => (v === "yes" ? true : v === "no" ? false : null);
const optionalInt = (v: FormDataEntryValue | null, what: string) => {
  const text = String(v ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isInteger(n)) throw new TrainingError(`Enter ${what} as a whole number.`);
  return n;
};

export async function saveCertificationTypeAction(prev: TrainingFormState, formData: FormData): Promise<TrainingFormState> {
  const values = {
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? ""),
    validityMonths: String(formData.get("validityMonths") ?? ""),
    graceDays: String(formData.get("graceDays") ?? ""),
    reminderDays: String(formData.get("reminderDays") ?? ""),
    autoGrant: String(formData.get("autoGrant") ?? ""),
    required: String(formData.get("required") ?? ""),
    active: formData.get("active") === "on" ? "on" : "",
    categoryIds: formData.getAll("categoryIds").map(String),
    machineIds: formData.getAll("machineIds").map(String),
  };
  try {
    const auth = await requireTypeEditor();
    const input = {
      name: values.name,
      description: values.description,
      validityMonths: optionalInt(values.validityMonths, "the validity in months"),
      graceDays: optionalInt(values.graceDays, "the grace period in days") ?? 0,
      reminderDays: values.reminderDays.split(/[\s,]+/).filter(Boolean).map(Number),
      autoGrant: yesNo(formData.get("autoGrant")),
      required: yesNo(formData.get("required")),
      active: values.active === "on",
      categoryIds: ids(formData.getAll("categoryIds")),
      machineIds: ids(formData.getAll("machineIds")),
    };
    if (input.reminderDays.some((d) => !Number.isInteger(d))) throw new TrainingError("Enter the reminder days as numbers, e.g. 60, 30, 7.");
    const typeId = String(formData.get("id") ?? "");
    if (typeId) await updateCertificationType(getDb(), auth.organizationId, id.parse(typeId), input);
    else await createCertificationType(getDb(), auth.organizationId, input);
  } catch (err) {
    if (err instanceof TrainingError) return { error: err.message, version: prev.version + 1, values };
    throw err;
  }
  redirect("/training#certifications");
}

export async function addCategoryAction(prev: TrainingFormState, formData: FormData): Promise<TrainingFormState> {
  try {
    const auth = await requireTypeEditor();
    await addCategory(getDb(), auth.organizationId, String(formData.get("name") ?? ""));
  } catch (err) {
    if (err instanceof TrainingError) return { error: err.message, version: prev.version + 1, values: { name: String(formData.get("name") ?? "") } };
    throw err;
  }
  refresh();
  return { error: null, version: prev.version + 1 };
}

export async function deleteCategoryAction(formData: FormData) {
  const auth = await requireTypeEditor();
  await deleteCategory(getDb(), auth.organizationId, id.parse(formData.get("id")));
  refresh();
}

/** Certificates: a photo (shrunk in the browser) or a PDF, kept privately like checklist photos. */
const DOCUMENT_RULES = { maxBytes: 3_800_000, types: ["image/jpeg", "image/png", "image/webp", "application/pdf"] };

async function readDocument(organizationId: number, file: FormDataEntryValue | null) {
  if (!(file instanceof File) || file.size === 0) return null;
  if (!DOCUMENT_RULES.types.includes(file.type)) throw new TrainingError("The certificate must be a photo (JPEG, PNG, WebP) or a PDF.");
  if (file.size > DOCUMENT_RULES.maxBytes) throw new TrainingError("The certificate file is too big (3.8 MB at most).");
  if (!photoStorageAvailable()) throw new TrainingError("File storage isn't set up, so the certificate can't be kept. Save without it.");
  const key = await saveDocument(organizationId, new Uint8Array(await file.arrayBuffer()), file.type);
  return { key, contentType: file.type };
}

const RECORD_FIELDS = ["certificationTypeId", "issuedOn", "expiresOn", "provider", "certificateNumber", "notes"] as const;

export async function saveTrainingRecordAction(prev: TrainingFormState, formData: FormData): Promise<TrainingFormState> {
  const values = Object.fromEntries(RECORD_FIELDS.map((f) => [f, String(formData.get(f) ?? "")]));
  let document: Awaited<ReturnType<typeof readDocument>> = null;
  try {
    const auth = await requireAuth("manager");
    const input = {
      certificationTypeId: Number(values.certificationTypeId) || 0,
      issuedOn: values.issuedOn,
      expiresOn: values.expiresOn || null,
      provider: values.provider,
      certificateNumber: values.certificateNumber,
      notes: values.notes,
    };
    const recordId = String(formData.get("id") ?? "");
    const db = getDb();
    document = await readDocument(auth.organizationId, formData.get("document"));
    if (recordId) {
      await updateTrainingRecord(db, auth.organizationId, id.parse(recordId), input, document);
    } else {
      await addTrainingRecord(db, auth.organizationId, id.parse(formData.get("operatorId")), input, { userId: auth.userId, email: auth.email }, document);
    }
  } catch (err) {
    if (document) await deletePhotos([document.key]); // not saved: don't keep the file
    if (err instanceof TrainingError) return { error: err.message, version: prev.version + 1, values };
    throw err;
  }
  refresh();
  return { error: null, version: prev.version + 1 };
}

export async function deleteTrainingRecordAction(formData: FormData) {
  const auth = await requireAuth("manager");
  await deleteTrainingRecord(getDb(), auth.organizationId, id.parse(formData.get("id")));
  refresh();
}

export type ScanResult = { ok: true; fields: TrainingFields; nameWarning: string | null } | { ok: false; error: string };

/**
 * Scan to fill: reads a certificate photo for the record form (managers). Saves nothing: the form shows the details
 * for the manager to check, and the photo is only kept if they save the record with it attached.
 */
export async function scanCertificateAction(formData: FormData): Promise<ScanResult> {
  const auth = await requireAuth("manager");
  if (!scanAvailable()) return { ok: false, error: "Scanning isn't set up yet (ANTHROPIC_API_KEY)." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a photo of the certificate." };
  const db = getDb();
  const [types, [op]] = await Promise.all([
    db.select({ id: certificationTypes.id, name: certificationTypes.name }).from(certificationTypes).where(eq(certificationTypes.organizationId, auth.organizationId)),
    db
      .select({ name: operators.name })
      .from(operators)
      .where(and(eq(operators.id, id.parse(formData.get("operatorId"))), eq(operators.organizationId, auth.organizationId))),
  ]);
  if (!op) return { ok: false, error: "Operator not found." };
  try {
    const fields = await scanTrainingCertificate({ data: new Uint8Array(await file.arrayBuffer()), contentType: file.type }, types);
    const nameWarning =
      fields.holderName && !sameName(fields.holderName, op.name) ? `The card is in the name of "${fields.holderName}", not ${op.name}. Check it's the right person.` : null;
    return { ok: true, fields, nameWarning };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.message };
    throw err;
  }
}
