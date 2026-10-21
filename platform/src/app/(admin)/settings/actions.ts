"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { PrivacyError, RETENTION_KEYS, updatePrivacySettings, type RetentionKey } from "@/lib/privacy";
import { requireAuth } from "@/lib/session";

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
