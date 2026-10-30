"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { viewOrganization } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AccountError, createOrganization } from "@/lib/organizations";
import { MachineError, reactivateDevice, retireDevice, setDeviceStock } from "@/lib/machines";
import { requirePlatformAdmin } from "@/lib/session";
import { cancelCommand, CommandError, queueCommand } from "@/lib/commands";

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

/** Move an unpaired device into a customer's spare stock, or back to Veristart's (empty value). */
export async function setDeviceStockAction(prev: PlatformFormState, formData: FormData): Promise<PlatformFormState> {
  await requirePlatformAdmin();
  const deviceId = z.string().min(1).max(32).parse(formData.get("deviceId"));
  const raw = String(formData.get("organizationId") ?? "");
  try {
    await setDeviceStock(getDb(), deviceId, raw ? z.coerce.number().int().positive().parse(raw) : null);
  } catch (err) {
    if (err instanceof MachineError) return { error: err.message, version: prev.version + 1 };
    throw err;
  }
  refresh();
  return { error: null, version: prev.version + 1 };
}

/** Take a device out of service (test devices, lost or scrapped units), or put it back. */
export async function retireDeviceAction(formData: FormData) {
  await requirePlatformAdmin();
  const deviceId = z.string().min(1).max(32).parse(formData.get("deviceId"));
  if (formData.get("reactivate") === "1") await reactivateDevice(getDb(), deviceId);
  else await retireDevice(getDb(), deviceId);
  refresh();
}

export type CommandFormState = { error: string | null; queued: boolean; version: number };

/** Queue a command for a device; it goes out with the reply to the device's next contact. */
export async function queueCommandAction(prev: CommandFormState, formData: FormData): Promise<CommandFormState> {
  const auth = await requirePlatformAdmin();
  const deviceId = z.string().min(1).max(32).parse(formData.get("deviceId"));
  const kind = String(formData.get("kind") ?? "");
  const values = Object.fromEntries(["times", "seconds", "ssid", "password"].map((k) => [k, String(formData.get(k) ?? "")]));
  try {
    await queueCommand(getDb(), deviceId, kind, values, auth.email);
  } catch (err) {
    if (err instanceof CommandError) return { error: err.message, queued: false, version: prev.version + 1 };
    throw err;
  }
  refresh();
  return { error: null, queued: true, version: prev.version + 1 };
}

export async function cancelCommandAction(formData: FormData) {
  await requirePlatformAdmin();
  const deviceId = z.string().min(1).max(32).parse(formData.get("deviceId"));
  await cancelCommand(getDb(), deviceId, z.coerce.number().int().positive().parse(formData.get("id")));
  refresh();
}
