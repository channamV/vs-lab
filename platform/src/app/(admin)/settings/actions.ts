"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
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
