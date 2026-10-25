"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { requireAuth, requirePlatformAdmin } from "@/lib/session";
import { getDb } from "@/lib/db";
import { tierEnum } from "@/lib/db/schema";
import { createMachine, MachineError, pairDevice, unpairDevice, updateMachine } from "@/lib/machines";
import { assertDivisionChoice, assertMachineInScope, DivisionError } from "@/lib/divisions";
import { recordEvent } from "@/lib/notifications";
import { afterEvents } from "@/lib/alert-jobs";
import { and, eq } from "drizzle-orm";
import { machineCategories } from "@/lib/db/schema";
import { scanAvailable, ScanError, scanSerialPlate, type PlateFields } from "@/lib/scan";
import { guessCategory } from "@/lib/training";
import { lookupSerial, normalizeSerial, repairVin, type SerialLookup } from "@/lib/vin";

/** What was typed, to refill the form after an error (React clears it after every submit). */
export type MachineFields = Record<(typeof FIELDS)[number], string>;
/** `version` changes on every submit so the form re-renders with the saved or typed values. */
export type MachineFormState = { error: string | null; version: number; values?: MachineFields };

const FIELDS = ["name", "unitNumber", "machineType", "make", "model", "year", "serialNumber", "fuelTankLitres", "speedLimitKph", "tier", "divisionId", "categoryId", "onRoad"] as const;

const MachineInput = z.object({
  name: z.string().max(80),
  unitNumber: z.string().max(20),
  machineType: z.string().max(40),
  make: z.string().max(40),
  model: z.string().max(40),
  year: z.string().trim().max(4),
  serialNumber: z.string().max(40),
  fuelTankLitres: z.string().trim().max(8),
  speedLimitKph: z.string().trim().max(8),
  tier: z.enum(tierEnum.enumValues),
  divisionId: z.string().regex(/^\d*$/),
  categoryId: z.string().regex(/^\d*$/),
  onRoad: z.string(),
});

function readFields(formData: FormData): MachineFields {
  return Object.fromEntries(FIELDS.map((f) => [f, String(formData.get(f) ?? "")])) as MachineFields;
}

function toInput(values: MachineFields) {
  const input = MachineInput.parse({ ...values, tier: values.tier || "gps" });
  const year = input.year ? Number(input.year) : null;
  if (year !== null && !Number.isInteger(year)) throw new MachineError("Enter a valid model year.");
  const fuelTankLitres = input.fuelTankLitres ? Number(input.fuelTankLitres) : null;
  if (fuelTankLitres !== null && !Number.isFinite(fuelTankLitres)) throw new MachineError("Enter the fuel tank size in litres.");
  const speedLimitKph = input.speedLimitKph ? Number(input.speedLimitKph) : null;
  if (speedLimitKph !== null && !Number.isFinite(speedLimitKph)) throw new MachineError("Enter the top speed in km/h.");
  return { ...input, year, fuelTankLitres, speedLimitKph, divisionId: input.divisionId ? Number(input.divisionId) : null, categoryId: input.categoryId ? Number(input.categoryId) : null, onRoad: input.onRoad === "on" };
}

export async function addMachineAction(prev: MachineFormState, formData: FormData): Promise<MachineFormState> {
  const auth = await requireAuth("manager");
  const values = readFields(formData);
  let id: number;
  try {
    const input = toInput(values);
    await assertDivisionChoice(getDb(), auth, input.divisionId);
    ({ id } = await createMachine(getDb(), auth.organizationId, input));
    afterEvents([
      await recordEvent(getDb(), { organizationId: auth.organizationId, machineId: id, type: "equipment_created", detail: `Added by ${auth.email}` }),
    ]);
  } catch (err) {
    if (err instanceof MachineError || err instanceof DivisionError) return { error: err.message, version: prev.version + 1, values };
    throw err;
  }
  redirect(`/machines/${id}`);
}

export async function updateMachineAction(prev: MachineFormState, formData: FormData): Promise<MachineFormState> {
  const auth = await requireAuth("manager");
  const id = z.coerce.number().int().positive().parse(formData.get("id"));
  const values = readFields(formData);
  try {
    const input = toInput(values);
    await assertMachineInScope(getDb(), auth, id);
    await assertDivisionChoice(getDb(), auth, input.divisionId);
    await updateMachine(getDb(), auth.organizationId, id, input);
    afterEvents([
      await recordEvent(getDb(), { organizationId: auth.organizationId, machineId: id, type: "equipment_updated", detail: `Changed by ${auth.email}` }),
    ]);
  } catch (err) {
    if (err instanceof MachineError || err instanceof DivisionError) return { error: err.message, version: prev.version + 1, values };
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

export type SerialLookupResult = (SerialLookup & { categoryId: number | null; correctedFrom: string | null }) | { kind: "error"; error: string };

export type PlateScanResult = { ok: true; fields: PlateFields; categoryId: number | null; lookup: SerialLookupResult | null } | { ok: false; error: string };

async function categoryFor(organizationId: number, machineType: string | null) {
  const name = guessCategory(machineType);
  if (!name) return null;
  const [cat] = await getDb()
    .select({ id: machineCategories.id })
    .from(machineCategories)
    .where(and(eq(machineCategories.organizationId, organizationId), eq(machineCategories.name, name)));
  return cat?.id ?? null;
}

/** Checks a serial number (fixing an obvious misread when `repair`) and decodes a VIN; the category follows its type. */
async function checkSerial(organizationId: number, serial: string, repair: boolean): Promise<SerialLookupResult> {
  const typed = normalizeSerial(serial);
  const fixed = repair ? repairVin(typed) : typed;
  const result = await lookupSerial(fixed);
  return {
    ...result,
    categoryId: result.kind === "vin" ? await categoryFor(organizationId, result.decoded.machineType) : null,
    correctedFrom: fixed !== typed ? typed : null,
  };
}

/**
 * Scan to fill: reads a serial plate or VIN photo for the machine form (managers), then checks the number in the same
 * step (VIN decoded with NHTSA, equipment PIN maker). Saves nothing, and the photo isn't kept.
 */
export async function scanPlateAction(formData: FormData): Promise<PlateScanResult> {
  const auth = await requireAuth("manager");
  if (!scanAvailable()) return { ok: false, error: "Scanning isn't set up yet (ANTHROPIC_API_KEY)." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a photo of the plate or VIN." };
  try {
    const fields = await scanSerialPlate({ data: new Uint8Array(await file.arrayBuffer()), contentType: file.type });
    let lookup: SerialLookupResult | null = null;
    if (fields.serialNumber) {
      try {
        lookup = await checkSerial(auth.organizationId, fields.serialNumber, true);
      } catch (err) {
        // The scan itself worked; the number check is a bonus.
        console.error("serial check after scan failed", err);
      }
    }
    return { ok: true, fields, categoryId: await categoryFor(auth.organizationId, fields.machineType), lookup };
  } catch (err) {
    if (err instanceof ScanError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * VIN / PIN lookup for the machine form (managers): checks a VIN's check digit and decodes it with NHTSA, or names
 * an equipment PIN's manufacturer. Saves nothing; only the number is sent to NHTSA. A typed number isn't "repaired"
 * (the manager can see what they typed); I/O/Q get the usual explanation instead.
 */
export async function lookupSerialAction(serial: string): Promise<SerialLookupResult> {
  const auth = await requireAuth("manager");
  const value = z.string().trim().min(1).max(40).safeParse(serial);
  if (!value.success) return { kind: "error", error: "Enter the serial number or VIN first." };
  return checkSerial(auth.organizationId, value.data, false);
}
