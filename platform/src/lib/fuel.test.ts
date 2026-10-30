import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { devices, engineSessions, fuelEvents, machines, notificationEvents, organizations } from "@/lib/db/schema";
import { createMachine, pairDevice } from "@/lib/machines";
import { ingestSamples } from "@/lib/telemetry/ingest";
import { checkFuelTheft, checkFuelWhileRunning, median } from "./fuel";

let db: Db;
let machineId: number;
const t0 = new Date("2026-10-20T21:00:00Z"); // 5 PM Toronto
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
/** A report while running (OBD RPM 900) with a fuel level, or a stopped report. */
const running = (fuel: number | null, min: number, field = "obdFuelLevelPct") =>
  ingestSamples(db, "DEV1", [{ obdRpm: 900, ...(fuel === null ? {} : { [field]: fuel }) }], { now: at(min) });
const stopped = (min: number) => ingestSamples(db, "DEV1", [{ obdRpm: 0 }], { now: at(min) });
/** Runs for a few minutes at `levels`, checking after each report. */
async function run(levels: number[], fromMin: number, field?: string) {
  const raised = [];
  for (let i = 0; i < levels.length; i++) {
    await running(levels[i], fromMin + i, field);
    raised.push(...(await checkFuelTheft(db, machineId, at(fromMin + i))));
  }
  return raised;
}

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  const [org] = await db.insert(organizations).values({ name: "ABC" }).returning();
  ({ id: machineId } = await createMachine(db, org.id, { name: "Loader", unitNumber: "7", fuelTankLitres: 400 }));
  await db.insert(devices).values({ id: "DEV1" });
  await pairDevice(db, "DEV1", machineId, at(-60));
});

describe("fuel theft", () => {
  it("takes the median, so one sloshing reading doesn't count", () => {
    expect(median([60, 61, 30, 60, 62])).toBe(60);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("alerts when the tank is lower at the next start than at the last stop", async () => {
    expect(await run([70, 70, 69, 70, 70, 69], 0)).toEqual([]); // first start: nothing to compare with
    await stopped(10);
    const raised = await run([52, 52, 53, 52, 51, 52], 13 * 60); // next morning: 18% gone
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ type: "fuel-theft", title: "Possible fuel theft: Unit 7 · Loader" });
    expect(raised[0].detail).toMatch(/^The fuel level dropped from 70% to 52% \(about 72 L of the 400 L tank\) while the engine was off: stopped .*, started again .* \(12 h 5\d min later\)\. Check the tank and fuel cap\.$/);
    // Checked once per start.
    expect(await checkFuelTheft(db, machineId, at(13 * 60 + 10))).toEqual([]);
    const [session] = await db.select().from(engineSessions).where(eq(engineSessions.id, raised[0].engineSessionId!));
    expect(session.fuelStartPct).toBe(52);
  });

  it("needs a 10% drop on car and pickup fuel gauges (OBD), which swing more", async () => {
    // The F-150, 2026-10-30: 34% at the stop, 29% at the next start: 5 points, inside the gauge's own swing.
    await run([34, 34, 34, 34, 34], 0);
    await stopped(10);
    expect(await run([29, 29, 29, 29, 29, 29], 30)).toEqual([]);
    await stopped(40);
    // A real 12-point drop still alerts.
    expect(await run([17, 17, 17, 17, 17, 17], 70)).toHaveLength(1);
  });

  it("ignores readings taken just after braking", async () => {
    const at2 = (min: number, sec: number) => new Date(t0.getTime() + min * 60_000 + sec * 1000);
    const send = (fields: Record<string, number>, when: Date) => ingestSamples(db, "DEV1", [{ obdRpm: 900, ...fields }], { now: when });
    await run([52, 52, 52, 52, 52], 0);
    await stopped(10);
    // Next start: drives off, brakes hard, and the gauge reads 20% for the next 25 seconds (fuel sloshing), then 52%.
    await send({ obdFuelLevelPct: 52 }, at2(30, 0));
    await send({ obdSpeedKph: 40, obdFuelLevelPct: 50 }, at2(31, 0));
    for (const sec of [10, 20, 25]) await send({ obdSpeedKph: 0, obdFuelLevelPct: 20 }, at2(31, sec));
    for (const min of [33, 34, 35]) await send({ obdSpeedKph: 0, obdFuelLevelPct: 52 }, at2(min, 0));
    expect(await checkFuelTheft(db, machineId, at2(35, 1))).toEqual([]);
    const [session] = await db.select().from(engineSessions).where(eq(engineSessions.startedAt, at2(30, 0)));
    expect(session?.fuelStartPct).toBe(52);
  });

  it("logs a refuel while parked", async () => {
    await run([30, 30, 30, 30, 30], 0);
    await stopped(10);
    await run([92, 92, 92, 92, 92], 600);
    const [refuel] = await db.select().from(fuelEvents);
    expect(refuel).toMatchObject({ kind: "refuel", when: "parked", fromPct: 30, toPct: 92, litres: 248 });
    expect((await db.select().from(notificationEvents)).find((e) => e.type === "refuel")?.detail).toBe("Refuelled: 30% → 92%, about 248 L.");
  });

  it("ignores normal use, refuelling, small drops, and waits for the level to settle", async () => {
    await run([70, 70, 70, 70, 70], 0);
    await stopped(10);
    // Refuelled overnight.
    expect(await run([95, 95, 95, 95, 95], 600)).toEqual([]);
    await stopped(700);
    // 4% lower: within normal sensor and slope differences.
    expect(await run([91, 91, 91, 91, 91], 800)).toEqual([]);
    await stopped(900);
    // Too soon after the start: no decision yet.
    await running(60, 1000);
    expect(await checkFuelTheft(db, machineId, at(1001))).toEqual([]);
    expect((await db.select().from(engineSessions).orderBy(engineSessions.id)).at(-1)!.fuelCheckedAt).toBeNull();
  });

  it("needs at least 20 L when the tank size is known, and works from J1939 fuel level", async () => {
    await db.update(machines).set({ fuelTankLitres: 200 }).where(eq(machines.id, machineId));
    await run([50, 50, 50, 50, 50], 0, "j1939FuelLevelPct");
    await stopped(10);
    expect(await run([42, 42, 42, 42, 42], 600, "j1939FuelLevelPct")).toEqual([]); // 8% of 200 L = 16 L
    await stopped(700);
    expect(await run([30, 30, 30, 30, 30], 800, "j1939FuelLevelPct")).toHaveLength(1); // 12% = 24 L
  });

  it("gives up quietly on machines that don't report fuel level", async () => {
    for (let m = 0; m <= 16; m += 2) await running(null, m);
    expect(await checkFuelTheft(db, machineId, at(16))).toEqual([]);
    expect((await db.select().from(engineSessions))[0].fuelCheckedAt).toEqual(at(16));
  });
});

describe("while running", () => {
  /** A J1939 report: RPM, tank level and the engine's total fuel meter. */
  const j1939 = (level: number, totalL: number, min: number) =>
    ingestSamples(db, "DEV1", [{ j1939Rpm: 1500, j1939FuelLevelPct: level, j1939TotalFuelL: totalL }], { now: at(min) });
  /** Reports every minute from `from` to `to`, with the level and meter given by functions of the minute. */
  async function drive(from: number, to: number, level: (m: number) => number, total: (m: number) => number) {
    const raised = [];
    for (let m = from; m <= to; m++) {
      await j1939(level(m), total(m), m);
      raised.push(...(await checkFuelTheft(db, machineId, at(m))), ...(await checkFuelWhileRunning(db, machineId, at(m))));
    }
    return raised;
  }

  it("doesn't alert when the tank drops by what the engine burned", async () => {
    // 400 L tank, burning 24 L/h: 0.1% of the tank a minute.
    expect(await drive(0, 90, (m) => 80 - m * 0.1, (m) => 10_000 + m * 0.4)).toEqual([]);
    expect(await db.select().from(fuelEvents)).toEqual([]);
  });

  it("alerts when the tank drops more than the engine burned (siphoning while idling)", async () => {
    // Normal for 20 minutes, then 15% (60 L) disappears in 5 minutes while the meter says ~2 L were burned.
    const level = (m: number) => (m < 20 ? 80 : m < 25 ? 80 - (m - 20) * 3 : 65);
    const raised = await drive(0, 40, level, (m) => 10_000 + m * 0.4);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ type: "fuel-loss", title: "Possible fuel theft (while running): Unit 7 · Loader" });
    expect(raised[0].detail).toMatch(/the tank dropped from 80% to 65% \(about 60 L\), but the engine only burned \d+ L: about 4\d L is unaccounted for/);
    expect(await db.select().from(fuelEvents)).toMatchObject([{ kind: "loss", when: "running", alertId: raised[0].id }]);
  });

  it("ignores levels read while moving (fuel sloshing in a car)", async () => {
    // The CX-9, 2026-10-28: 38% at the start, the gauge reading 50% at times while driving, 37% when parked again.
    const drive = (fuel: number, kph: number, min: number) =>
      ingestSamples(db, "DEV1", [{ obdRpm: 2000, obdSpeedKph: kph, obdFuelLevelPct: fuel }], { now: at(min) });
    const raised = [];
    for (let m = 0; m <= 40; m++) {
      await drive(m < 3 ? 38 : m < 38 ? (m % 2 ? 50 : 41) : 37, m < 3 || m >= 38 ? 0 : 60, m);
      raised.push(...(await checkFuelTheft(db, machineId, at(m))), ...(await checkFuelWhileRunning(db, machineId, at(m))));
    }
    expect(raised).toEqual([]);
    expect(await db.select().from(fuelEvents)).toEqual([]);
    // A real refuel at the pump (stopped) is still logged.
    for (let m = 41; m <= 60; m++) {
      await drive(m < 45 ? 37 : 95, 0, m);
      await checkFuelWhileRunning(db, machineId, at(m));
    }
    expect(await db.select().from(fuelEvents)).toMatchObject([{ kind: "refuel", when: "running", fromPct: 38, toPct: 95 }]);
  });

  it("logs a refuel while running, and needs the fuel meter and tank size for the loss check", async () => {
    // OBD machine (no fuel meter): refuel detected, but a drop can't be compared with fuel burned.
    const raised = [];
    for (let m = 0; m <= 30; m++) {
      await running(m < 10 ? 40 : m < 20 ? 90 : 70, m);
      raised.push(...(await checkFuelTheft(db, machineId, at(m))), ...(await checkFuelWhileRunning(db, machineId, at(m))));
    }
    expect(raised).toEqual([]);
    expect(await db.select().from(fuelEvents)).toMatchObject([{ kind: "refuel", when: "running", fromPct: 40, toPct: 90 }]);
  });
});
