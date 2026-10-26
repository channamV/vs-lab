"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { maintenanceIssues, maintenanceSchedules } from "@/lib/db/schema";
import { assertMachineInScope } from "@/lib/divisions";
import {
  addAttachment,
  addReading,
  createManualIssue,
  createSchedule,
  deleteIssue,
  deleteSchedule,
  MaintenanceError,
  openServiceNow,
  removeAttachment,
  updateIssue,
  updateSchedule,
  type IssuePatch,
  type ScheduleInput,
} from "@/lib/maintenance";
import { MAINTENANCE_RULES } from "@/lib/maintenance-types";
import { deletePhotos, photoStorageAvailable, saveDocument } from "@/lib/photos";
import { requireAuth } from "@/lib/session";

/** Maintenance actions: managers and owners, on machines in their divisions (docs/maintenance.md). */

export type FormState = { status: "idle" | "saved" | "error"; message?: string; values?: Record<string, string>; attempt?: number };

const id = z.coerce.number().int().positive();
const text = (formData: FormData, key: string) => (formData.has(key) ? String(formData.get(key) ?? "") : undefined);

async function issueInScope(issueId: number) {
  const auth = await requireAuth("manager");
  const db = getDb();
  const [issue] = await db
    .select({ id: maintenanceIssues.id, machineId: maintenanceIssues.machineId })
    .from(maintenanceIssues)
    .where(and(eq(maintenanceIssues.id, issueId), eq(maintenanceIssues.organizationId, auth.organizationId)));
  if (!issue) throw new MaintenanceError("That maintenance item doesn't exist.");
  await assertMachineInScope(db, auth, issue.machineId);
  return { auth, db, issue };
}

const failed = (e: unknown, prev: FormState, values?: Record<string, string>): FormState => {
  if (e instanceof MaintenanceError) return { status: "error", message: e.message, values, attempt: (prev.attempt ?? 0) + 1 };
  throw e;
};

export async function createIssueAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = Object.fromEntries(["machineId", "title", "priority", "complaint"].map((k) => [k, String(formData.get(k) ?? "")]));
  let issueId: number;
  try {
    const auth = await requireAuth("manager");
    const machineId = Number(values.machineId) || 0;
    if (!machineId) throw new MaintenanceError("Choose a machine.");
    await assertMachineInScope(getDb(), auth, machineId).catch(() => {
      throw new MaintenanceError("Choose a machine.");
    });
    issueId = (await createManualIssue(getDb(), auth.organizationId, auth.userId, { machineId, title: values.title, priority: values.priority, complaint: values.complaint })).id;
  } catch (e) {
    return failed(e, prev, values);
  }
  redirect(`/maintenance/issues/${issueId}`);
}

/** Saves the issue card. intent=resolve also resolves it (needs all three C's). */
export async function saveIssueAction(prev: FormState, formData: FormData): Promise<FormState> {
  const fields = ["status", "priority", "title", "complaint", "cause", "correction", "performedBy", "vendorName", "servicedHours", "servicedKm", "servicedOn"] as const;
  const patch: IssuePatch = Object.fromEntries(fields.map((k) => [k, text(formData, k)]).filter(([, v]) => v !== undefined));
  if (formData.get("intent") === "resolve") patch.status = "resolved";
  const values = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? ""]));
  try {
    const { auth, db, issue } = await issueInScope(id.parse(formData.get("issueId")));
    await updateIssue(db, auth.organizationId, issue.id, auth.userId, patch);
  } catch (e) {
    return failed(e, prev, values);
  }
  refresh();
  return { status: "saved", message: formData.get("intent") === "resolve" ? "Resolved." : "Saved.", attempt: (prev.attempt ?? 0) + 1 };
}

/** Quick status change (board and issue card header). */
export async function setStatusAction(formData: FormData) {
  const { auth, db, issue } = await issueInScope(id.parse(formData.get("issueId")));
  await updateIssue(db, auth.organizationId, issue.id, auth.userId, { status: String(formData.get("status") ?? "") });
  refresh();
}

export async function uploadAttachmentAction(prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { auth, db, issue } = await issueInScope(id.parse(formData.get("issueId")));
    const files = formData.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) throw new MaintenanceError("Choose a file.");
    if (!photoStorageAvailable()) throw new MaintenanceError("File storage isn't set up, so files can't be kept.");
    for (const file of files.slice(0, 6)) {
      if (!MAINTENANCE_RULES.attachmentTypes.includes(file.type)) throw new MaintenanceError(`${file.name}: only photos (JPEG, PNG, WebP) and PDFs.`);
      if (file.size > MAINTENANCE_RULES.attachmentMaxBytes) throw new MaintenanceError(`${file.name} is too big (3.8 MB at most).`);
      const key = await saveDocument(auth.organizationId, new Uint8Array(await file.arrayBuffer()), file.type);
      await addAttachment(db, auth.organizationId, issue.id, auth.userId, {
        section: String(formData.get("section") ?? ""),
        storageKey: key,
        filename: file.name,
        contentType: file.type,
        bytes: file.size,
      });
    }
  } catch (e) {
    return failed(e, prev);
  }
  refresh();
  return { status: "saved", attempt: (prev.attempt ?? 0) + 1 };
}

export async function removeAttachmentAction(formData: FormData) {
  const { auth, db } = await issueInScope(id.parse(formData.get("issueId")));
  const key = await removeAttachment(db, auth.organizationId, id.parse(formData.get("attachmentId")), auth.userId);
  await deletePhotos([key]);
  refresh();
}

export async function deleteIssueAction(formData: FormData) {
  const { auth, db, issue } = await issueInScope(id.parse(formData.get("issueId")));
  await deletePhotos(await deleteIssue(db, auth.organizationId, issue.id));
  redirect("/maintenance");
}

// ---------- Schedules and readings ----------

const SCHEDULE_FIELDS = ["machineId", "description", "everyDays", "everyHours", "everyKm", "lastDoneOn", "lastDoneHours", "lastDoneKm"] as const;

export async function saveScheduleAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values: Record<string, string> = Object.fromEntries([...SCHEDULE_FIELDS, "everyMonths"].map((k) => [k, String(formData.get(k) ?? "")]));
  // "Every N months" is entered as months and kept as days (30 per month).
  const months = Number(values.everyMonths.trim());
  const everyDays = values.everyDays || (Number.isFinite(months) && months > 0 ? String(Math.round(months * 30)) : "");
  try {
    const auth = await requireAuth("manager");
    const db = getDb();
    const machineId = Number(values.machineId) || 0;
    await assertMachineInScope(db, auth, machineId).catch(() => {
      throw new MaintenanceError("Choose a machine.");
    });
    const scheduleId = Number(formData.get("scheduleId")) || 0;
    // New schedules start active; the edit form has an Active tick box.
    const input: ScheduleInput = {
      machineId,
      description: values.description,
      everyDays,
      everyHours: values.everyHours,
      everyKm: values.everyKm,
      lastDoneOn: values.lastDoneOn,
      lastDoneHours: values.lastDoneHours,
      lastDoneKm: values.lastDoneKm,
      active: scheduleId ? formData.get("active") === "on" : true,
    };
    if (scheduleId) {
      const [old] = await db
        .select({ machineId: maintenanceSchedules.machineId })
        .from(maintenanceSchedules)
        .where(and(eq(maintenanceSchedules.id, scheduleId), eq(maintenanceSchedules.organizationId, auth.organizationId)));
      if (!old) throw new MaintenanceError("That schedule doesn't exist.");
      await assertMachineInScope(db, auth, old.machineId);
      await updateSchedule(db, auth.organizationId, scheduleId, input);
    } else await createSchedule(db, auth.organizationId, auth.userId, input);
  } catch (e) {
    return failed(e, prev, values);
  }
  redirect("/maintenance/schedules");
}

async function scheduleInScope(scheduleId: number) {
  const auth = await requireAuth("manager");
  const db = getDb();
  const [s] = await db
    .select({ id: maintenanceSchedules.id, machineId: maintenanceSchedules.machineId })
    .from(maintenanceSchedules)
    .where(and(eq(maintenanceSchedules.id, scheduleId), eq(maintenanceSchedules.organizationId, auth.organizationId)));
  if (!s) throw new MaintenanceError("That schedule doesn't exist.");
  await assertMachineInScope(db, auth, s.machineId);
  return { auth, db, schedule: s };
}

export async function deleteScheduleAction(formData: FormData) {
  const { auth, db, schedule } = await scheduleInScope(id.parse(formData.get("scheduleId")));
  await deleteSchedule(db, auth.organizationId, schedule.id);
  redirect("/maintenance/schedules");
}

/** Opens the schedule's service item now (or goes to the one already open). */
export async function openServiceNowAction(formData: FormData) {
  const { auth, db, schedule } = await scheduleInScope(id.parse(formData.get("scheduleId")));
  const { issue } = await openServiceNow(db, auth.organizationId, schedule.id, auth.userId);
  redirect(`/maintenance/issues/${issue.id}`);
}

export async function addReadingAction(prev: FormState, formData: FormData): Promise<FormState> {
  const values = { reading: String(formData.get("reading") ?? ""), kind: String(formData.get("kind") ?? "") };
  try {
    const auth = await requireAuth("manager");
    const machineId = id.parse(formData.get("machineId"));
    await assertMachineInScope(getDb(), auth, machineId);
    await addReading(getDb(), auth.organizationId, machineId, auth.userId, values.kind, values.reading);
  } catch (e) {
    return failed(e, prev, values);
  }
  refresh();
  return { status: "saved", message: "Reading saved.", attempt: (prev.attempt ?? 0) + 1 };
}
