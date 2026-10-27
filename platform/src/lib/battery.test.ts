import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { devices, machines, notificationEvents, organizations, telemetry } from "@/lib/db/schema";
import { createMachine, pairDevice } from "@/lib/machines";
import { ingestSamples, recordEvent } from "@/lib/telemetry/ingest";
import { batteryThreshold } from "./battery";

let db: Db;
let machineId: number;
const t0 = new Date("2026-10-21T10:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const volts = (v: number, extra: Record<string, number> = {}) => [{ batteryCentivolts: Math.round(v * 100), ...extra }];
const report = (v: number, min: number, extra: Record<string, number> = {}) => ingestSamples(db, "DEV1", volts(v, extra), { now: at(min) });
const warnings = async () => (await db.select().from(notificationEvents)).filter((e) => e.type === "low_battery");
const machine = async () => (await db.select().from(machines).where(eq(machines.id, machineId)))[0];

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  const [org] = await db.insert(organizations).values({ name: "ABC" }).returning();
  ({ id: machineId } = await createMachine(db, org.id, { name: "Loader", unitNumber: "7" }));
  await db.insert(devices).values({ id: "DEV1" });
  await pairDevice(db, "DEV1", machineId, at(-60));
});

describe("low battery warning", () => {
  it("knows 12 V from 24 V systems", () => {
    expect(batteryThreshold(12.2)).toEqual({ system: 12, threshold: 11.9 });
    expect(batteryThreshold(24.5)).toEqual({ system: 24, threshold: 23.8 });
  });

  it("warns once when an engine-off reading stays low, and clears when it's healthy again", async () => {
    await report(12.5, 0);
    await report(11.6, 1); // first low reading: wait for confirmation
    expect(await warnings()).toEqual([]);
    await report(11.5, 5);
    const [w] = await warnings();
    expect(w.detail).toBe("Battery at 11.5 V with the engine off (12 V system; the warning level is 11.9 V). The machine may not start: check or charge the battery.");
    expect(await machine()).toMatchObject({ batteryLowAt: at(5), batteryLowVolts: expect.closeTo(11.5, 3) });
    await report(11.4, 30);
    expect(await warnings()).toHaveLength(1); // one per low spell
    await report(12.1, 60); // above 11.9 but not by the 0.4 V margin: still low
    expect((await machine()).batteryLowAt).not.toBeNull();
    await report(12.6, 90);
    expect((await machine()).batteryLowAt).toBeNull();
    await report(11.0, 100);
    await report(11.0, 110);
    expect(await warnings()).toHaveLength(2);
  });

  it("uses the voltage from parked check-ins (&BV=): stored for the chart, and warns about a draining battery", async () => {
    const parked = (cv: number, min: number, type = "login") => recordEvent(db, "DEV1", { type, batteryCentivolts: cv }, { now: at(min) });
    await parked(1240, 0);
    await parked(1180, 15, "logout");
    expect(await warnings()).toEqual([]);
    await parked(1175, 30);
    expect(await warnings()).toHaveLength(1);
    expect(await machine()).toMatchObject({ lastBatteryV: expect.closeTo(11.75, 3) });
    const rows = await db.select().from(telemetry).orderBy(telemetry.id);
    expect(rows.map((r) => [r.batteryV, r.engineOn, r.lat])).toEqual([
      [12.4, false, null],
      [11.8, false, null],
      [11.75, false, null],
    ]);
    // A desk device on USB isn't a machine battery.
    await parked(368, 45);
    expect(await warnings()).toHaveLength(1);
  });

  it("ignores the dip while cranking and readings with the engine running", async () => {
    await report(10.2, 0); // cranking
    await report(14.1, 0.5); // running: the alternator lifts the voltage
    await report(11.0, 10, { obdRpm: 800 }); // low but running (by RPM): not a resting reading
    await report(12.5, 20, { obdRpm: 0 });
    expect(await warnings()).toEqual([]);
    expect((await machine()).batteryLowPendingAt).toBeNull();
  });

  it("ignores readings from USB or a bench supply (below 8 V): not on machine power", async () => {
    // Y5725A32 on a desk, on USB power (2026-10-24): 361–369 cV. RPM 0 makes them engine-off readings.
    await report(3.61, 0, { obdRpm: 0 });
    await report(3.65, 4, { obdRpm: 0 });
    await report(3.69, 10, { obdRpm: 0 });
    expect(await warnings()).toEqual([]);
    expect((await machine()).batteryLowPendingAt).toBeNull();
    // At the floor it's machine power again, and very low: warned as usual.
    await report(8.0, 20, { obdRpm: 0 });
    await report(8.0, 24, { obdRpm: 0 });
    expect(await warnings()).toHaveLength(1);
  });

  it("works for 24 V machines", async () => {
    await report(23.2, 0);
    await report(23.1, 4);
    expect((await warnings())[0].detail).toMatch(/^Battery at 23\.1 V .*24 V system; the warning level is 23\.8 V/);
  });
});
