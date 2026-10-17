"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { viewOrganization } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AccountError, assignDevice, createOrganization } from "@/lib/organizations";
import { requirePlatformAdmin } from "@/lib/session";

/** Platform admins (Veristart staff) only. */

export async function switchOrganizationAction(formData: FormData) {
  const auth = await requirePlatformAdmin();
  const id = z.coerce.number().int().positive().parse(formData.get("organizationId"));
  await viewOrganization(getDb(), auth, id);
  redirect("/");
}

export type PlatformFormState = { error: string | null; version: number };

export async function createOrganizationAction(prev: PlatformFormState, formData: FormData): Promise<PlatformFormState> {
  await requirePlatformAdmin();
  try {
    await createOrganization(getDb(), String(formData.get("name") ?? "").slice(0, 120));
  } catch (err) {
    if (err instanceof AccountError) return { error: err.message, version: prev.version + 1 };
    throw err;
  }
  refresh();
  return { error: null, version: prev.version + 1 };
}

export async function assignDeviceAction(formData: FormData) {
  await requirePlatformAdmin();
  const deviceId = z.string().min(1).max(32).parse(formData.get("deviceId"));
  const raw = String(formData.get("organizationId") ?? "");
  await assignDevice(getDb(), deviceId, raw ? z.coerce.number().int().positive().parse(raw) : null);
  refresh();
}
