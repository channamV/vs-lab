import { randomInt } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { deviceAssignments, devices, divisions, engineSessions, machineCategories, machines, organizations, type Tier } from "@/lib/db/schema";

/**
 * Machines (the customer's equipment) and devices (the tracking hardware on them).
 * A machine owns its data; a device supplies it while paired. Pairing is done by Veristart staff.
 * Plain functions that take the database, so they can be tested without a server.
 */

export class MachineError extends Error {}

// No 0/o, 1/l/i: the code is printed under the QR sticker and may be read out over the phone.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** The random code in a machine's QR sticker URL (/checkin/<code>). Hard to guess, easy to read. */
export function newMachineCode(): string {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

export type MachineInput = {
  name: string;
  unitNumber?: string;
  machineType?: string;
  make?: string;
  model?: string;
  year?: number | null;
  serialNumber?: string;
  /** Litres; null = unknown. Left out = unchanged. */
  fuelTankLitres?: number | null;
  /** km/h; null = the fleet limit applies. Left out = unchanged. */
  speedLimitKph?: number | null;
  tier?: Tier;
  /** Null = no division. Left out = unchanged (edit) / none (new). */
  divisionId?: number | null;
  /** Machine category (training coverage). Null = none. Left out = unchanged. */
  categoryId?: number | null;
};

const clean = (v: string | undefined) => v?.trim() || null;

async function cleanInput(db: Db, organizationId: number, input: MachineInput, exceptMachineId?: number) {
  const name = input.name.trim();
  if (!name) throw new MachineError("Enter the machine's name.");
  const unitNumber = clean(input.unitNumber);
  if (unitNumber) {
    const [taken] = await db
      .select({ id: machines.id })
      .from(machines)
      .where(
        and(
          eq(machines.organizationId, organizationId),
          eq(machines.unitNumber, unitNumber),
          exceptMachineId ? ne(machines.id, exceptMachineId) : undefined,
        ),
      );
    if (taken) throw new MachineError(`Unit ${unitNumber} is already used by another machine.`);
  }
  const year = input.year ?? null;
  if (year !== null && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1)) {
    throw new MachineError("Enter a valid model year.");
  }
  const tank = input.fuelTankLitres;
  if (tank !== undefined && tank !== null && (!Number.isFinite(tank) || tank < 5 || tank > 10_000)) {
    throw new MachineError("Fuel tank size must be between 5 and 10,000 litres.");
  }
  const speed = input.speedLimitKph;
  if (speed !== undefined && speed !== null && (!Number.isFinite(speed) || speed < 5 || speed > 200)) {
    throw new MachineError("The top speed must be between 5 and 200 km/h.");
  }
  if (input.divisionId) {
    const [division] = await db
      .select({ id: divisions.id })
      .from(divisions)
      .where(and(eq(divisions.id, input.divisionId), eq(divisions.organizationId, organizationId)));
    if (!division) throw new MachineError("Division not found.");
  }
  if (input.categoryId) {
    const [category] = await db
      .select({ id: machineCategories.id })
      .from(machineCategories)
      .where(and(eq(machineCategories.id, input.categoryId), eq(machineCategories.organizationId, organizationId)));
    if (!category) throw new MachineError("Category not found.");
  }
  return {
    name,
    unitNumber,
    machineType: clean(input.machineType),
    make: clean(input.make),
    model: clean(input.model),
    year,
    serialNumber: clean(input.serialNumber),
    ...(tank !== undefined && { fuelTankLitres: tank }),
    ...(speed !== undefined && { speedLimitKph: speed }),
    ...(input.tier && { tier: input.tier }),
    ...(input.divisionId !== undefined && { divisionId: input.divisionId }),
    ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
  };
}

export async function createMachine(db: Db, organizationId: number, input: MachineInput) {
  const values = await cleanInput(db, organizationId, input);
  const [machine] = await db
    .insert(machines)
    .values({ organizationId, code: newMachineCode(), ...values })
    .returning();
  return machine;
}

export async function updateMachine(db: Db, organizationId: number, machineId: number, input: MachineInput) {
  const values = await cleanInput(db, organizationId, input, machineId);
  const updated = await db
    .update(machines)
    .set(values)
    .where(and(eq(machines.id, machineId), eq(machines.organizationId, organizationId)))
    .returning({ id: machines.id });
  if (updated.length === 0) throw new MachineError("Machine not found.");
}

/** The open pairing for a device, if any. */
async function openPairing(db: Db, where: ReturnType<typeof eq>) {
  const [row] = await db
    .select()
    .from(deviceAssignments)
    .where(and(where, isNull(deviceAssignments.endedAt)));
  return row ?? null;
}

/**
 * Staff: put a device on a machine. From then on, the device's data belongs to the machine.
 * The device must be in Veristart's stock or the machine's organization's stock, and neither the
 * device nor the machine may already be paired (unpair first: that keeps the history clear).
 */
export async function pairDevice(db: Db, deviceId: string, machineId: number, now = new Date()) {
  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId));
  if (!device) throw new MachineError("Device not found.");
  const [machine] = await db.select().from(machines).where(eq(machines.id, machineId));
  if (!machine) throw new MachineError("Machine not found.");
  if (device.organizationId !== null && device.organizationId !== machine.organizationId) {
    throw new MachineError("That device is in another organization's stock. Take it back to Veristart stock first.");
  }
  if (await openPairing(db, eq(deviceAssignments.deviceId, deviceId))) {
    throw new MachineError("That device is already on a machine. Unpair it first.");
  }
  if (await openPairing(db, eq(deviceAssignments.machineId, machineId))) {
    throw new MachineError("That machine already has a device. Unpair it first.");
  }
  await db.transaction(async (tx) => {
    await tx.update(devices).set({ organizationId: machine.organizationId }).where(eq(devices.id, deviceId));
    await tx.insert(deviceAssignments).values({ deviceId, machineId, startedAt: now });
  });
}

/**
 * Staff: take a device off its machine (failed, being replaced, moved). The device stays in the
 * customer's stock, ready to pair with another of their machines. The machine keeps all its history;
 * any engine-on period is closed at the device's last report, and its engine state becomes unknown
 * until a new device reports.
 */
export async function unpairDevice(db: Db, deviceId: string, now = new Date()) {
  const pairing = await openPairing(db, eq(deviceAssignments.deviceId, deviceId));
  if (!pairing) return;
  await db.transaction(async (tx) => {
    await tx.update(deviceAssignments).set({ endedAt: now }).where(eq(deviceAssignments.id, pairing.id));
    const [open] = await tx
      .select()
      .from(engineSessions)
      .where(and(eq(engineSessions.machineId, pairing.machineId), isNull(engineSessions.endedAt)));
    if (open) await tx.update(engineSessions).set({ endedAt: open.lastSeenAt }).where(eq(engineSessions.id, open.id));
    await tx.update(machines).set({ engineOn: null, engineChangedAt: now, engineUnknownSince: null }).where(eq(machines.id, pairing.machineId));
  });
}

/**
 * Staff: move an unpaired device into an organization's stock (available for their machines), or back
 * to Veristart's stock (null).
 */
export async function setDeviceStock(db: Db, deviceId: string, organizationId: number | null) {
  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId));
  if (!device) throw new MachineError("Device not found.");
  if (await openPairing(db, eq(deviceAssignments.deviceId, deviceId))) {
    throw new MachineError("That device is on a machine. Unpair it first.");
  }
  if (organizationId !== null) {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
    if (!org) throw new MachineError("Organization not found.");
  }
  await db.update(devices).set({ organizationId }).where(eq(devices.id, deviceId));
}
