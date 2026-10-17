"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { requireAuth, requirePlatformAdmin } from "@/lib/session";
import { getDb } from "@/lib/db";
import { tierEnum } from "@/lib/db/schema";
import { createMachine, MachineError, pairDevice, unpairDevice, updateMachine } from "@/lib/machines";

/** What was typed, to refill the form after an error (React clears it after every submit). */
export type MachineFields = Record<(typeof FIELDS)[number], string>;
/** `version` changes on every submit so the form re-renders with the saved or typed values. */
export type MachineFormState = { error: string | null; version: number; values?: MachineFields };

const FIELDS = ["name", "unitNumber", "machineType", "make", "model", "year", "serialNumber", "tier"] as const;

const MachineInput = z.object({
  name: z.string().max(80),
  unitNumber: z.string().max(20),
  machineType: z.string().max(40),
  make: z.string().max(40),
  model: z.string().max(40),
  year: z.string().trim().max(4),
  serialNumber: z.string().max(40),
  tier: z.enum(tierEnum.enumValues),
});

function readFields(formData: FormData): MachineFields {
  return Object.fromEntries(FIELDS.map((f) => [f, String(formData.get(f) ?? "")])) as MachineFields;
}

function toInput(values: MachineFields) {
  const input = MachineInput.parse({ ...values, tier: values.tier || "gps" });
  const year = input.year ? Number(input.year) : null;
  if (year !== null && !Number.isInteger(year)) throw new MachineError("Enter a valid model year.");
  return { ...input, year };
}

export async function addMachineAction(prev: MachineFormState, formData: FormData): Promise<MachineFormState> {
  const auth = await requireAuth("manager");
  const values = readFields(formData);
  let id: number;
  try {
    ({ id } = await createMachine(getDb(), auth.organizationId, toInput(values)));
  } catch (err) {
    if (err instanceof MachineError) return { error: err.message, version: prev.version + 1, values };
    throw err;
  }
  redirect(`/machines/${id}`);
}

export async function updateMachineAction(prev: MachineFormState, formData: FormData): Promise<MachineFormState> {
  const auth = await requireAuth("manager");
  const id = z.coerce.number().int().positive().parse(formData.get("id"));
  const values = readFields(formData);
  try {
    await updateMachine(getDb(), auth.organizationId, id, toInput(values));
  } catch (err) {
    if (err instanceof MachineError) return { error: err.message, version: prev.version + 1, values };
    throw err;
  }
  refresh();
  return { error: null, version: prev.version + 1 };
}

export type PairingState = { error: string | null; version: number };

/** Veristart staff only: pair a device with a machine, or take it off. */
export async function pairDeviceAction(prev: PairingState, formData: FormData): Promise<PairingState> {
  await requirePlatformAdmin();
  const machineId = z.coerce.number().int().positive().parse(formData.get("machineId"));
  const deviceId = z.string().min(1).max(32).parse(formData.get("deviceId"));
  try {
    await pairDevice(getDb(), deviceId, machineId);
  } catch (err) {
    if (err instanceof MachineError) return { error: err.message, version: prev.version + 1 };
    throw err;
  }
  refresh();
  return { error: null, version: prev.version + 1 };
}

export async function unpairDeviceAction(formData: FormData) {
  await requirePlatformAdmin();
  await unpairDevice(getDb(), z.string().min(1).max(32).parse(formData.get("deviceId")));
  refresh();
}
