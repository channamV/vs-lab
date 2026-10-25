import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { deviceAssignments, devices, engineSessions, machines, organizations } from "@/lib/db/schema";
import { createMachine, MachineError, newMachineCode, pairDevice, setDeviceStock, unpairDevice, updateMachine } from "./machines";

let db: Db;
let orgA: number;
let orgB: number;
const at = (min: number) => new Date(Date.parse("2026-10-15T12:00:00Z") + min * 60_000);
const device = async (id: string) => (await db.select().from(devices).where(eq(devices.id, id)))[0];

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  [{ id: orgA }, { id: orgB }] = await db
    .insert(organizations)
    .values([{ name: "ABC Civil" }, { name: "XYZ Paving" }])
    .returning();
  await db.insert(devices).values([{ id: "DEV1" }, { id: "DEV2" }]); // new, in Veristart stock
});

describe("machines", () => {
  it("get a random, readable QR code", () => {
    const code = newMachineCode();
    expect(code).toMatch(/^[a-z2-9]{8}$/);
    expect(code).not.toMatch(/[01ilo]/);
    expect(newMachineCode()).not.toBe(code);
  });

  it("store the equipment details, with unit numbers unique per organization", async () => {
    const m = await createMachine(db, orgA, {
      name: " Excavator ",
      unitNumber: "14",
      machineType: "Excavator",
      make: "Cat",
      model: "320",
      year: 2019,
      serialNumber: "CAT0320XYZ",
      tier: "monitor",
    });
    expect(m).toMatchObject({ name: "Excavator", unitNumber: "14", make: "Cat", year: 2019, tier: "monitor", organizationId: orgA });
    await expect(createMachine(db, orgA, { name: "Loader", unitNumber: "14" })).rejects.toThrow(/Unit 14 is already used/);
    await createMachine(db, orgB, { name: "Loader", unitNumber: "14" }); // another organization: fine
    await expect(createMachine(db, orgA, { name: " " })).rejects.toBeInstanceOf(MachineError);
    await expect(createMachine(db, orgA, { name: "Old", year: 1800 })).rejects.toThrow(/year/);
  });

  it("can only be edited by their own organization", async () => {
    const m = await createMachine(db, orgA, { name: "Excavator", unitNumber: "14" });
    await updateMachine(db, orgA, m.id, { name: "Excavator", unitNumber: "14", make: "Deere" }); // keeping its own unit # is fine
    await expect(updateMachine(db, orgB, m.id, { name: "Hacked" })).rejects.toThrow(/not found/);
    const [row] = await db.select().from(machines).where(eq(machines.id, m.id));
    expect(row).toMatchObject({ name: "Excavator", make: "Deere" });
  });
});

describe("pairing devices with machines", () => {
  it("pairs a stock device, moving it into the customer's stock", async () => {
    const m = await createMachine(db, orgA, { name: "Excavator" });
    await pairDevice(db, "DEV1", m.id, at(0));
    expect((await device("DEV1")).organizationId).toBe(orgA);
    expect(await db.select().from(deviceAssignments)).toEqual([
      expect.objectContaining({ deviceId: "DEV1", machineId: m.id, startedAt: at(0), endedAt: null }),
    ]);
  });

  it("allows one device per machine and one machine per device", async () => {
    const m1 = await createMachine(db, orgA, { name: "Excavator" });
    const m2 = await createMachine(db, orgA, { name: "Loader" });
    await pairDevice(db, "DEV1", m1.id);
    await expect(pairDevice(db, "DEV1", m2.id)).rejects.toThrow(/already on a machine/);
    await expect(pairDevice(db, "DEV2", m1.id)).rejects.toThrow(/already has a device/);
  });

  it("won't pair a device that's in another organization's stock", async () => {
    await setDeviceStock(db, "DEV1", orgB);
    const m = await createMachine(db, orgA, { name: "Excavator" });
    await expect(pairDevice(db, "DEV1", m.id)).rejects.toThrow(/another organization's stock/);
  });

  it("unpairing keeps the device in the customer's stock and closes the machine's engine period", async () => {
    const m = await createMachine(db, orgA, { name: "Excavator" });
    await pairDevice(db, "DEV1", m.id, at(0));
    await db.insert(engineSessions).values({ machineId: m.id, startedAt: at(10), lastSeenAt: at(20) });
    await db.update(machines).set({ engineOn: true, engineUnknownSince: at(30) });

    await unpairDevice(db, "DEV1", at(60));
    const [pairing] = await db.select().from(deviceAssignments);
    expect(pairing.endedAt).toEqual(at(60));
    expect((await device("DEV1")).organizationId).toBe(orgA);
    const [session] = await db.select().from(engineSessions);
    expect(session.endedAt).toEqual(at(20));
    expect((await db.select().from(machines))[0]).toMatchObject({ engineOn: null, engineUnknownSince: null });

    // A replacement goes on the same machine; the old device can go on another of ABC's machines.
    await pairDevice(db, "DEV2", m.id, at(70));
    const other = await createMachine(db, orgA, { name: "Loader" });
    await pairDevice(db, "DEV1", other.id, at(80));
    expect(await db.select().from(deviceAssignments).where(eq(deviceAssignments.machineId, m.id))).toHaveLength(2);
  });

  it("staff can return an unpaired device to Veristart stock", async () => {
    const m = await createMachine(db, orgA, { name: "Excavator" });
    await pairDevice(db, "DEV1", m.id);
    await expect(setDeviceStock(db, "DEV1", null)).rejects.toThrow(/Unpair it first/);
    await unpairDevice(db, "DEV1");
    await setDeviceStock(db, "DEV1", null);
    expect((await device("DEV1")).organizationId).toBeNull();
  });
});
