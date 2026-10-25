"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { PrivacyError, RETENTION_KEYS, updatePrivacySettings, type RetentionKey } from "@/lib/privacy";
import { requireAuth } from "@/lib/session";
import { SafetyError, updateSafetySettings } from "@/lib/safety";
import { isTimezone } from "@/lib/schedule-time";

const SAFETY_FIELDS = ["speedLimitKph", "idleAlertMinutes", "fatigueDailyHours", "fatigueContinuousHours", "postedLimitTolerancePct"] as const;

export type SettingsFormState = { error: string | null; saved: boolean; version: number; values?: Record<string, string> };

/** Owners only: privacy contact and how long data is kept. */
export async function savePrivacySettingsAction(prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const auth = await requireAuth("owner");
  const values = Object.fromEntries(["privacyContact", ...RETENTION_KEYS].map((k) => [k, String(formData.get(k) ?? "")]));
  const days = Object.fromEntries(RETENTION_KEYS.map((k) => [k, z.coerce.number().catch(NaN).parse(values[k])])) as Record<RetentionKey, number>;
  try {
    await updatePrivacySettings(getDb(), auth.organizationId, { privacyContact: values.privacyContact, ...days });
  } catch (err) {
    if (err instanceof PrivacyError) return { error: err.message, saved: false, version: prev.version + 1, values };
    throw err;
  }
  refresh();
  return { error: null, saved: true, version: prev.version + 1 };
}

export type PlanFormState = { error: string | null; saved: boolean; version: number };

/** Owners only: the working plan reports measure utilization against. */
export async function saveReportPlanAction(prev: PlanFormState, formData: FormData): Promise<PlanFormState> {
  const auth = await requireAuth("owner");
  const hours = Number(formData.get("plannedHoursPerDay"));
  const days = formData
    .getAll("workingDay")
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    return { error: "Hours per working day must be between 0 and 24.", saved: false, version: prev.version + 1 };
  }
  if (days.length === 0) return { error: "Tick at least one working day.", saved: false, version: prev.version + 1 };
  await getDb()
    .update(organizations)
    .set({ plannedHoursPerDay: Math.round(hours * 4) / 4, workingDays: [...new Set(days)].sort() })
    .where(eq(organizations.id, auth.organizationId));
  refresh();
  return { error: null, saved: true, version: prev.version + 1 };
}

/** Owners only: speed limit, idling limit and operator fatigue limits (src/lib/safety.ts). Blank = off. */
export async function saveSafetySettingsAction(prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const auth = await requireAuth("owner");
  const values = Object.fromEntries(SAFETY_FIELDS.map((k) => [k, String(formData.get(k) ?? "")])) as Record<(typeof SAFETY_FIELDS)[number], string>;
  try {
    await updateSafetySettings(getDb(), auth.organizationId, values);
  } catch (err) {
    if (err instanceof SafetyError) return { error: err.message, saved: false, version: prev.version + 1, values };
    throw err;
  }
  refresh();
  return { error: null, saved: true, version: prev.version + 1 };
}

/** Owners: the fleet timezone (default for new schedules). Veristart staff only: the schedule conflict rule. */
export async function saveScheduleSettingsAction(prev: PlanFormState, formData: FormData): Promise<PlanFormState> {
  const auth = await requireAuth("owner");
  const timezone = String(formData.get("timezone") ?? "");
  if (!isTimezone(timezone)) return { error: "Choose a timezone.", saved: false, version: prev.version + 1 };
  const rule = String(formData.get("conflictRule") ?? "");
  await getDb()
    .update(organizations)
    .set({
      timezone,
      // The conflict rule is a Veristart decision per company (V1-267): ignored unless staff send it.
      ...(auth.isPlatformAdmin && (rule === "least_restrictive" || rule === "most_restrictive") && { scheduleConflictRule: rule }),
    })
    .where(eq(organizations.id, auth.organizationId));
  refresh();
  return { error: null, saved: true, version: prev.version + 1 };
}

/** Owners: whether a scanned certificate is kept with the training record by default (the manager can still choose). */
export async function saveScanSettingsAction(prev: PlanFormState, formData: FormData): Promise<PlanFormState> {
  const auth = await requireAuth("owner");
  await getDb()
    .update(organizations)
    .set({ retainScanImages: formData.get("retainScanImages") === "on" })
    .where(eq(organizations.id, auth.organizationId));
  refresh();
  return { error: null, saved: true, version: prev.version + 1 };
}
